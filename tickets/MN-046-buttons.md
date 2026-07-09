---
id: MN-046
title: Button fields — one-click manual actions on a record
status: todo
depends_on: []
size: L
---

**Ask (founder, 2026-07-09):** buttons that run some sort of automations.

## Research

- **Airtable button field**: label + style + ONE action; lives in the grid as a real button. Simplicity is the feature.
- **Fibery buttons**: per-database, multiple declarative actions (update entity, create linked entity, notify), optional confirmation, run as the clicking user, visible on entity view + grids.
- **Notion buttons**: a checklist of primitives (edit props, add page, show confirmation) — confirms the primitive set.

**Synthesis:** a button is a field whose config is an ordered list of **declarative actions** executed server-side in one transaction when pressed. Three primitives cover the real use cases ("Approve", "Start sprint", "Request changes", "Log a call"): set fields on this record, create a linked record, add a comment. Deliberately not Turing-complete — that's MN-047's job to extend, not this field's.

## Design

### Action schema (shared with MN-047 — build once)

```
Action =
  | { type: 'set_values', values: Record<apiName, Value | '@me' | '@now' | '@today'> }
  | { type: 'create_record', database_id, values: {...same tokens}, link_via_relation_field_id? }
  | { type: 'add_comment', body_template: string }   // supports {Field Name} interpolation + @me
```

- Tokens: `@me` (acting user id — valid in user fields), `@now`/`@today` (date fields), `{Field}` interpolation in comment templates (reuses the formula tokenizer's field-ref piece if MN-043 lands first; otherwise a simple `{...}` replacer).
- Validation at save (like `assertLookupConfig`): every referenced field exists and the static value type-checks against the field validator; `create_record.database_id` must be in the workspace; `link_via_relation_field_id` must be a relation on the target pointing back at this database.

### Field type + config

- New type `button` (enum migration), config `{ label: string, color?: paletteKey, confirm?: string, actions: Action[] }` (1–10 actions).
- Stores no record value ever — like lookups, `record-values` rejects writes; `project()` skips it.

### Execution

- `POST /workspaces/:ws/databases/:db/records/:rec/buttons/:field/press`
- Guard: `assertAccess(editor)` — pressing mutates records, so editor+ (incl. guest editors); creators define.
- `AutomationActionsService.execute(actions, ctx)` where ctx = `{ actorId, record, defs, tx }`:
  1. runs inside ONE transaction — an invalid action mid-list rolls back the whole press (never half-applied);
  2. `set_values` goes through the normal RecordsService.update path (validators, activity diff);
  3. `create_record` uses RecordsService.create + RelationsService.addLinks for the link-back;
  4. `add_comment` posts as the actor.
- Response: `{ pressed: true, effects: [{type, record_id}...] }` for UI toasts.
- Activity: `button.pressed` event with button name + effect summary (the underlying updates also log normally — the press event groups them narratively).
- **Rate limit**: 10 presses / 10s / user / button (idempotency is not guaranteed — double-click protection client-side + this cap server-side).

### UI

**Rendering** — in cells and on the entity property row: a real `<button>` (small, filled with the config color or accent), label text, pressed state = spinner; on success a toast lists effects ("Set State → Done · Commented"). `confirm` set → window.confirm first. Read-only/viewer/commenter see a disabled button with tooltip "Requires editor access".

**Management surface (revised after Fibery sidebar screenshot):** Fibery lists *Buttons* as a per-database section beside Automation Rules. We mirror that: database ⋯ menu → **"Buttons & automations"** panel with two tabs (Buttons | Rules — Rules tab lands with MN-047). The Buttons tab lists button fields with their action summaries and opens the same builder; buttons remain field-typed underneath (they render in grids), but management is centralized.

**Builder** (in Add/Edit field dialog when type=button, and from the panel):
- Label + color swatch + optional confirmation text.
- Action list: each row = type select + its mini-form:
  - set_values → repeated (field picker → value editor for that field type, `@me`/`@today` offered contextually);
  - create_record → database picker → title template + link-back relation select (auto-detected candidates);
  - add_comment → textarea with `{Field}` hint.
- Add/remove/reorder (same dnd pattern as options editor); live JSON kept in field config shape.

## Implementation plan

1. Action zod schemas in packages/schemas + validation helpers; enum migration.
2. `AutomationActionsService` (execute + save-time validate) with unit tests — this is the piece MN-047 inherits, so its interface takes `(actions, ctx)` and never references buttons.
3. Press endpoint + guards + rate limit + activity event; integration tests: multi-action press, rollback on invalid mid-list action, commenter 403, guest-editor 200.
4. Builder UI; cell/property rendering with pressed/disabled states.
5. Browser-verify a 3-action button end-to-end; template packs MAY adopt one showcase button (Client Space "Approve deliverable") — nice-to-have, not AC.

## Edge cases

- Button pressed on a record whose fields were deleted since config → save-time validation is stale; execution re-validates and returns a structured 422 ("This button references a deleted field — edit the button"), never a 500.
- Self-referencing set_values on select options that were deleted → same re-validation.
- Two users pressing simultaneously → both succeed (last-write-wins on set_values, standard for our records).

## Out of scope

Webhooks/HTTP actions, notifications as an action (waits for MN-049's notification infra), conditional actions (that's MN-047 conditions), buttons in board cards (v1: table + entity page only).

## Acceptance criteria

- [ ] `button` type + Action schema with save-time and press-time validation
- [ ] Press endpoint: transactional multi-action execution as the presser, editor+ gated, rate-limited, activity-logged
- [ ] Tokens `@me`/`@now`/`@today` + `{Field}` comment interpolation
- [ ] Builder UI (3 action types, reorder), rendering in cells + entity page with pressed/disabled states
- [ ] Integration tests: multi-action, mid-list rollback, permission ladder, stale-config 422
