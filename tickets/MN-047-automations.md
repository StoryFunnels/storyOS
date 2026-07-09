---
id: MN-047
title: Automations — rules that run on record events or schedules
status: todo
depends_on: [MN-046]
size: XL
---

**Ask (founder, 2026-07-09):** workflows that do automations on a schedule / condition / trigger event.

## Research

- **Fibery automations**: per-database rules = trigger (created / updated-with-field-scope / linked / hourly-daily schedule) + filter + action list; a run log with per-run errors; rules auto-pause when they error repeatedly.
- **Linear**: few, opinionated, *scheduled* built-ins (auto-close stale issues, auto-archive completed) — evidence that time-based rules carry as much value as event rules; also the cleanest "recent runs" surface.
- **Airtable automations**: trigger → conditions → action steps; run history with input/output per step; monthly caps.
- **Notion database automations**: same triple, minimal but sufficient.

**Synthesis:** `rule = (trigger, condition, actions)` where actions are exactly MN-046's executor, conditions are exactly our view-filter AST, and the two hard engineering problems are **loop containment** and **observability** (run log). Everything else is assembly.

## Design

### Data model

```
automations:      id, database_id, name, enabled, trigger jsonb, condition jsonb|null,
                  actions jsonb, created_by, failure_streak int, created_at, updated_at
automation_runs:  id, automation_id, trigger_record_id|null, status enum(ok|error|skipped),
                  error text|null, effects jsonb|null, depth int, started_at, duration_ms
```

- `trigger` variants:
  - `{ type: 'record_created' }`
  - `{ type: 'record_updated', field_id?: string }` — optional scope to one field ("State changed")
  - `{ type: 'record_linked', relation_field_id: string }`
  - `{ type: 'schedule', every: 'hour' | 'day' | 'week', at?: 'HH:mm', weekday?: 0-6 }` — cron-lite on purpose; a full cron string is hostile UI
- `condition`: the existing filter AST (same shape views save) compiled by the existing query compiler for schedules, and evaluated in-process against the record snapshot for events (share the record-vs-filter matcher with the web's filter preview if practical; otherwise run the compiled SQL with `id = :recordId`, which reuses one code path — **chosen approach: SQL with id constraint**, zero new evaluator).
- `actions`: MN-046 `Action[]`, with one addition — for `schedule` triggers, `set_values`/`add_comment` apply to **each record matching the condition** (the condition IS the selection).

### Execution engine

**Event triggers** — after-commit hooks:
- RecordsService.create/update and RelationsService.addLinks emit an in-process `DomainEvent { type, databaseId, recordId, changedFieldIds, depth }` after their transaction commits (no dispatch on rollback).
- `AutomationsRunner` subscribes: loads enabled rules for the database matching the event type (+field scope), checks condition (SQL `WHERE id = record AND <compiled filter>`), executes actions via `AutomationActionsService` with `depth = event.depth + 1`.
- Runs are serialized per record (simple per-record promise chain) to avoid interleaved writes; failures never propagate to the user's original request.

**Loop containment** (the failure mode that kills these systems):
- Every automation-caused write carries `depth`; **max depth 2** (user action → rule A → rule B → stop). Depth-exceeded runs log status `skipped` with reason.
- `failure_streak` increments on error, resets on success; at 10 the rule flips `enabled=false` and (post-MN-049) notifies its creator.

**Scheduled triggers**:
- A `setInterval` worker in the API process ticks every 60s: `SELECT` enabled schedule rules whose `next_due_at <= now()` (materialized column updated after each run — no cron parsing at tick time), takes an advisory lock per rule (correctness on multi-node later, single-node now), selects matching records via the compiled condition (LIMIT 500/run, logged if truncated), executes actions per record at depth 1.
- Documented as single-process v1; the advisory lock makes it forward-compatible with multiple API replicas.

**Actor attribution**: runs execute as a synthetic actor `automation:<id>`; activity events render "⚡ <Rule name>" as the actor. Permission model: rules are creator-authored, so they act with full editor authority on their database — stated explicitly in docs (matches Fibery).

### API

- CRUD `/databases/:db/automations` (creator+): list, create, update (incl. enable/disable), delete.
- `GET /databases/:db/automations/:id/runs?cursor` — run history.
- `POST /databases/:db/automations/:id/test` — dry-run against a chosen record: evaluates condition + validates actions, returns would-do effects without writing. This is what makes rules debuggable.

### UI (database ⋯ menu → "Buttons & automations", Rules tab — shared panel with MN-046, mirroring Fibery's per-database Automation Rules / Buttons sections)

- **List**: rows = enabled toggle, name, human trigger sentence ("When State changes and Priority is Urgent → set Due, comment"), last-run status dot, run count. Disabled-by-failures rows show a warning banner.
- **Editor** (dialog or side panel): name → trigger picker (4 cards; schedule card reveals every/at/weekday selects) → condition = the existing FilterChip builder verbatim → actions = the MN-046 builder verbatim → footer: "Test with a record…" (record picker → dry-run result panel), Save.
- **Runs tab**: table of runs (when, trigger record link, status, duration, error or effect summary), retention 30 days (daily purge in the same worker).

## Implementation plan

1. Migrations (2 tables) + zod schemas + CRUD with validation (trigger shape, condition compiles, actions valid — reuse MN-046 validators).
2. DomainEvent emission from records/relations services (after-commit; carry depth through ctx).
3. Runner: event path (condition check, executor call, run logging, failure streak, depth guard) — integration tests are the core deliverable here: state-change rule fires; field-scoped rule ignores other fields; condition filters; A→B→A loop stops at depth 2 with a skipped run; 10 failures auto-disable.
4. Schedule worker: next_due_at computation, tick, advisory lock, LIMIT + truncation logging; test with a 1-minute schedule fixture (inject clock or set next_due_at directly).
5. Dry-run endpoint.
6. UI: list, editor (reusing filter + action builders), runs tab; browser-verify one event rule and one schedule rule end-to-end.
7. Docs: `docs/product/automations.md` — 6 recipes (auto-assign on Triage, close stale after 30d, notify-comment on Urgent, create onboarding checklist on client creation, weekly digest comment, archive Done after a week) + the depth/attribution rules.

## Edge cases

- Bulk import (MN-052) creating 5k records → each fires record_created rules: batch paths emit events with `suppressAutomations` option honored by the importer (documented choice: imports do NOT trigger automations; Airtable does the same).
- Rule edited while runs are in flight → runs capture the actions snapshot at dispatch.
- Record deleted between event and run → run logs `skipped: record gone`.
- Timezones for `at:` — workspace has no TZ yet; v1 runs in server TZ, noted in UI ("Server time"); workspace TZ is a follow-up.

## Out of scope

Webhooks in/out (v1.1 — activity table already makes this easy), cross-database triggers, per-step branching, AI actions (cloud tier later), email actions beyond comments.

## Open questions (founder)

- Should imports trigger automations? (Planned: no — matches Airtable; flag if you want otherwise.)
- Are 4 trigger types enough for JCM's first workflows, or is "record moved to space/board column X" (= field-scoped update, already covered) plus anything else needed day one?

## Acceptance criteria

- [ ] CRUD + validation for rules; enable/disable; creator-gated
- [ ] Event triggers fire after commit with field scoping; conditions via the compiled filter AST; actions via the shared executor
- [ ] Depth ≤ 2 loop guard and 10-failure auto-disable, both proven by tests
- [ ] Schedule worker fires within 60s of due, advisory-locked, LIMIT-capped with truncation logging
- [ ] Run log (status, error, effects, duration) with 30-day retention; dry-run endpoint
- [ ] Automations UI: list with human trigger sentences, editor reusing filter+action builders, runs tab
- [ ] docs/product/automations.md with recipes + semantics (depth, attribution, imports don't trigger)
