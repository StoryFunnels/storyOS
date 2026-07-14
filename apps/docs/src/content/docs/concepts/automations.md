---
title: Automations & buttons
description: Run actions when records change or on a schedule — set fields, create records, comment, notify — with a click or a trigger.
sidebar:
  order: 6
---

**Automations** are rules that run actions when records change or on a schedule. **Buttons** run
the same actions on a click. Open both from a database's `⋯` menu → **Buttons & automations**.

## Anatomy of a rule

**When** (trigger) → **Only if** (condition) → **Then** (actions)

- **Triggers** — *record created* · *record changes* (optionally scoped to one field, e.g. "when
  State changes") · *schedule* (hourly / daily / weekly at HH:mm, server time).
- **Condition** — any filter the [views](/concepts/views/) support. For scheduled rules the
  condition *is* the selection: the rule runs over every matching record.
- **Actions** (shared with buttons) — *set fields on this record* · *create a record* (optionally
  linked back through a relation) · *add a comment* · *update linked records* · *notify a person*.
  Tokens: `@me` (rule creator), `@today`, `@now`; `{Field Name}` interpolates values into comment
  and title templates.

## Recipes

| Goal | Rule |
|---|---|
| Escalate urgent tickets | When **State** changes · only if State is *Urgent* · add comment "⚠️ {Title} needs eyes" |
| Auto-stamp start dates | When **State** changes · only if State is *In Progress* · set *Started* = `@today` |
| Close stale Done work | Every day at 03:00 · only if State is *Done* · set *Archived* ✓ |
| Kickoff checklist on new client | When a record is created (Clients) · create a record in Tasks "Kickoff {Title}" linked back |
| Auto-assign triage | When a record is created · set *Assignee* = `@me` |
| Cascade project close | When a Project is marked Done · update linked records · set all its Tasks to Archived |

## Semantics worth knowing

- **Attribution** — runs act as the rule's creator; activity shows their name on the changes.
- **Loop guard** — an automation's own writes can trigger other rules **at most one more hop**
  (depth 2). Deeper cascades are skipped and logged, so a rule can never ping-pong forever.
- **Auto-disable** — 10 consecutive failures switch a rule off (with a banner); editing the actions
  or re-enabling resets the streak.
- **Run log** — every execution (ok / error / skipped) with duration is kept for 30 days.
- **Dry run** — test "would this run?" against a record without writing anything.
- **CSV imports do not fire automations** (mass-import safety).
- Scheduled rules process up to 500 matching records per tick and note truncation in the log.

## Buttons, agents, and the API

Buttons expose the same action set as a one-click field on a record — and the MCP `run_button`
tool lets an [AI agent](/mcp/overview/) press them. Automations and buttons are the substrate the
[agentic layer](/getting-started/what-is-storyos/#the-agentic-layer) builds on: triggers fire the
work, and the activity log records what happened.
