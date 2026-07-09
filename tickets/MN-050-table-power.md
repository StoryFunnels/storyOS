---
id: MN-050
title: Table power pack — multi-select, batch edit, quick-add, shortcuts
status: todo
depends_on: []
size: L
---

**Problem.** Every record operation is one-at-a-time. Linear users select 20 issues and change state/assignee in two keystrokes; that fluency is table stakes for a team that processes lists daily.

**Research.** Linear: `x` selects, shift-click ranges, floating bar shows count + actions (state, assignee, labels, delete), `Cmd+A` in view. Airtable: row checkboxes + right-click batch ops. Notion: checkbox column on hover, bulk property edit. Attio: selection bar with bulk update. Synthesis: **hover checkbox + shift-range selection, a floating action bar (set any editable field's value once → applied to all, plus batch delete with undo), and quick-add/new-record shortcuts**.

**Design.**

- Selection model in table view: hover checkbox in the row gutter, click = toggle, shift-click = range, header checkbox = page; `Escape` clears. Selected rows tinted.
- Floating bottom bar when >0 selected: "N selected · Set field ▾ · Move to trash · Clear". "Set field" opens a field picker → the field's normal editor → applies to all selected via the existing batch PATCH loop (sequential, toast progress); delete = existing soft delete with multi-undo toast.
- API: add `PATCH /records/batch` `{record_ids, values}` to make bulk sets one request (validator runs per record; partial failures reported).
- Shortcuts (documented in a `?` shortcuts overlay): `n` new record (focus title), `Cmd+K` palette, `x` toggle select on cursor row, `e` open record under cursor, `Escape` clear selection/edit.
- Batch limit 200 per operation with a clear message beyond that.

## Acceptance criteria

- [ ] Selection UX: hover checkboxes, shift ranges, select-page, Escape clears, selected styling
- [ ] Floating bar: batch set any editable field (incl. select/person/date via their editors), batch trash with undo
- [ ] `PATCH /records/batch` endpoint with per-record validation and partial-failure report + tests
- [ ] Keyboard: n / x / e / Escape + `?` shortcut overlay
- [ ] Editor-level access required; read-only users never see selection UI
