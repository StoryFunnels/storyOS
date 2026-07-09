---
id: MN-046
title: Button fields — one-click manual actions on a record
status: todo
depends_on: []
size: L
---

**Ask (founder, 2026-07-09):** buttons that run some sort of automations.

**Research.** Airtable button field: label + one action, rendered as a real button in the grid. Fibery buttons: per-database button with a small action script (update fields, create linked entities), confirmation optional, shown on entity view and grids. Notion buttons: block that runs a checklist of primitive actions (edit props, add page). Synthesis: **a button is a field whose config is a list of declarative actions executed server-side in one transaction when clicked; primitives cover 90%: set fields, create a linked record, nothing Turing-complete**.

**Design.**

- New field type `button`, config: `{ label, style?: color, confirm?: string, actions: Action[] }` where `Action` is one of:
  - `set_values` — patch fields on this record (static values or `@me` / `now()` tokens)
  - `create_record` — in a target database, with values + optional link back through a chosen relation
  - `add_comment` — post a templated comment as the clicking user
- `POST /records/:rec/buttons/:field/press` executes actions in one transaction with the **presser's** permissions (editor+ can press; creator defines). Activity event `button.pressed` records what changed.
- UI: renders as a small button (label, accent style) in cells and on the entity page; config UI = action list builder (add/remove/reorder actions, field pickers per action); optional confirm dialog before running.
- This is the manual half of the automation engine — MN-047 reuses the same `Action` schema and executor for triggered rules, so build the executor as a standalone `AutomationActionsService`.

## Acceptance criteria

- [ ] `button` type + config schema; actions validated against the schema graph (fields exist, relation targets valid)
- [ ] Press endpoint executes all actions transactionally as the presser; permission = editor on the database; activity logged
- [ ] set_values supports `@me` and `now()` tokens; create_record can link back via a relation
- [ ] Builder UI for actions; button renders in grid cells + entity page; optional confirmation
- [ ] Integration tests: multi-action press, permission denial for commenter, invalid config rejected
