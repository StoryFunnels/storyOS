---
id: MN-050
title: Table power pack — multi-select, batch edit, quick-add, shortcuts
status: done
depends_on: []
size: L
---

**Problem.** Every record operation is one-at-a-time. A Linear user selects twenty issues and changes state/assignee in two keystrokes; a JCM producer triaging a content list needs the same fluency, or the tool feels like a spreadsheet with extra steps.

## Research

- **Linear**: `x` toggles selection on the focused row, shift-click ranges, `Cmd+A` selects the view; a floating bar shows count + actions (state, assignee, labels, delete, "…"); every action applies instantly with an undo toast.
- **Airtable**: checkbox column on hover; right-click → batch ops; drag-fill (out of scope for us).
- **Notion**: hover checkboxes + bulk property menu; slower but proves the hover-checkbox affordance.
- **Attio**: selection bar bottom-center with "Update field" flow — the exact interaction we'll copy: pick a field once, use its normal editor once, apply to all.

**Synthesis:** hover checkbox + shift ranges + select-page; a floating action bar with *Set field* (any editable field via its existing editor), *Move to trash* (existing soft delete + batch undo); a batch endpoint so 200 updates are 1 request; and a first keyboard layer on the shortcut registry from MN-048.

## Design

### Selection model (table-view state)

- `selected: Set<recordId>` + `lastAnchorIndex` for ranges. Sources:
  - row gutter checkbox (appears on row hover or when any selection active — same slot as the Open/Trash icons, which shift right);
  - shift-click a checkbox → range from anchor;
  - header checkbox → toggles all *loaded* rows (virtualized pages loaded so far; label says "Select 128 loaded");
  - `x` toggles selection on the keyboard-cursor row; `Escape` clears (priority over clearing cell cursor).
- Selected rows get `bg-accent-soft` tint; selection survives sorting/paging but clears on view/database switch.
- Read-only users (below editor): selection UI entirely absent.

### Floating action bar

Bottom-center pill when `selected.size > 0`:
`N selected · [Set field ▾] [Move to trash] [Clear]`

- **Set field**: dropdown of editable fields (excludes title? no — title allowed; excludes lookup/formula/button/system). Picking one mounts that field's **existing editor** (CellEditor / RelationEditor / DatePicker / OptionList) in a popover anchored to the bar; committing applies the one value to all selected via the batch endpoint. Relation set = replace links on all (with a confirm note "replaces existing links on N records").
- **Move to trash**: soft-deletes all selected; one toast "N moved to trash — Undo" (undo restores all).
- Progress: optimistic cache update on success response; bar shows spinner while in flight; partial failures → toast "Updated 37, 3 failed (validation)" with the failures listed in console/details popover.

### API — `PATCH /workspaces/:ws/databases/:db/records/batch`

- Body `{ record_ids: string[] (≤200), values: Record<string, unknown> }` — one values patch applied to each id.
- Runs per-record through the existing validator + update path (activity per record, one shared transaction per chunk of 50); response `{ updated: n, failed: [{record_id, message}] }`.
- Same editor-access guard as single update; rate-limit exempt-ish (counts as one request).
- Batch delete: reuse existing DELETE per record? No — add `POST /records/batch-delete { record_ids }` (soft-delete set + return restored ids for undo) so undo is one call: `POST /records/batch-restore`.

### Keyboard layer (extends MN-048's registry; works without it by landing the registry here if built first)

| Key | Context | Action |
|---|---|---|
| `n` | database page | create record + focus title (existing + New flow) |
| `x` | table, cursor row | toggle select |
| `e` / `Enter on title col` | table | open record under cursor |
| `Escape` | table | clear selection → else clear cursor |
| `Cmd+A` | table focused | select loaded rows |
| `?` | anywhere | shortcuts overlay |

- `?` overlay: static dialog listing all shortcuts (incl. Cmd+K) — the discoverability surface Linear nails with its `?` panel.
- All handlers no-op when focus is in an input/textarea/contenteditable (registry already guards).

## Implementation plan

1. Batch endpoints (update/delete/restore) + validator-per-record + partial failure semantics + tests (mixed valid/invalid, 200-cap, permission).
2. Selection state + gutter checkboxes + ranges + header select + row tint (careful with virtualization: selection by id, checkbox state derived).
3. Floating bar: set-field flow reusing each editor component; trash + undo (batch restore).
4. Keyboard layer + `?` overlay; registry extraction if MN-048 hasn't landed.
5. Browser-verify: range-select 10, set State once, batch trash + undo; keyboard-only pass.

## Edge cases

- Selection + filters: "Set field" may move records out of the current filtered view — expected; toast counts still reported.
- Selecting while new pages load: header-checkbox re-tapped after load extends selection; count label always honest ("of loaded").
- Batch relation replace on one_to_many conflicts → per-record validator errors surface in the partial-failure list, not a wall of toasts.
- Undo after navigating away: toast persists 8s; restore endpoint is stateless so late clicks still work.

## Out of scope

Drag-fill, copy/paste grid ranges, bulk edit on boards/calendar (bar is table-only v1), CSV export of selection (pairs with MN-052 later), custom per-user shortcut remapping.

## Acceptance criteria

- [ ] Selection: hover/active checkboxes, shift ranges, select-loaded, `x`/`Escape`, tinting; absent for read-only
- [ ] Floating bar: set any editable field via its native editor, batch trash with one-toast undo, partial-failure reporting
- [ ] Batch update/delete/restore endpoints, ≤200, per-record validation, tests incl. mixed-failure case
- [ ] Shortcuts n/x/e/Escape/Cmd+A + `?` overlay on the shared registry, input-focus safe
