---
id: MN-047
title: Automations — rules that run on record events or schedules
status: todo
depends_on: [MN-046]
size: XL
---

**Ask (founder, 2026-07-09):** workflows that do automations on a schedule / condition / trigger event.

**Research.** Fibery automations: per-database rules = trigger (created / updated [specific field] / linked / scheduled) + optional filter + action list; run log with errors; disabled on failure loops. Linear: opinionated built-ins (auto-close stale, auto-archive, SLA escalation) — proof that *scheduled* rules matter as much as event rules. Airtable: trigger → conditions → actions with a run history and a hard cap per month. Notion (2023+): database automations with the same shape. Synthesis: **rule = (trigger, condition, actions); actions shared with buttons; every run logged; loop protection (an automation's own writes don't re-trigger other automations more than one hop); schedules via a worker tick**.

**Design.**

- Table `automations`: databaseId, name, enabled, trigger (`record_created` | `record_updated` (optional field filter) | `record_linked` | `schedule` (cron-lite: every hour/day/week at HH:mm)), condition (existing filter AST, reused from views), actions (same `Action[]` as MN-046 + `set_values` may target the triggering record), createdBy.
- Execution: event triggers hook into RecordsService/RelationsService after-commit (in-process dispatch, queued per event); scheduled triggers run from a `setInterval` worker in the API process (checks due schedules each minute — no external queue for self-hosted simplicity, documented as single-node v1).
- **Loop guard:** runs carry a depth counter; automation-caused writes dispatch with depth+1, max depth 2; per-rule failure counter auto-disables after 10 consecutive errors.
- Run log table (`automation_runs`: rule, trigger record, status, error, diff summary), kept 30 days.
- Runs execute as a system actor attributed "Automation: <name>" in activity; respects nothing less than editor-level writes (automations are creator-defined, so they act with database-level authority — documented).
- UI: database ⋯ menu → "Automations": list with enable toggles, rule editor (trigger picker → condition builder reusing the filter UI → actions builder from MN-046), run history tab with errors.

## Acceptance criteria

- [ ] CRUD for rules (creator+); trigger/condition/actions validated
- [ ] record_created / record_updated(field) / record_linked triggers fire after commit; schedule fires within a minute of due time
- [ ] Conditions evaluate through the existing filter compiler; actions reuse the MN-046 executor
- [ ] Loop guard (depth ≤ 2) + auto-disable after 10 consecutive failures; both covered by tests
- [ ] Run log with status/error/diff, surfaced in the Automations UI
- [ ] Integration tests: state-change rule updates a field, scheduled rule fires, condition filters correctly, loop A→B→A stops
