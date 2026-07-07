---
id: MN-016
title: Table view — virtualized, inline edit
status: done
depends_on: [MN-015]
size: L
---

The first real view. TanStack Table + Virtual over `POST /records/query`; per-type cell renderers and editors (text, number, checkbox, date picker, select/multi-select, url, email, user picker); inline editing with optimistic updates + rollback on error; "+ New" row; row click opens entity-page placeholder route; column resize (view persistence lands with MN-021).

## Acceptance criteria

- [ ] 10k-row database scrolls at 60fps (virtualized), loads via cursor pages
- [ ] Every v1 field type editable inline; failed saves roll back the optimistic value with a toast
- [ ] Keyboard: Enter commits, Esc cancels, arrow-key cell navigation
- [ ] "+ New" creates a record and focuses the title inline, no page reload
- [ ] Guests get a read-only table (cells not editable, no "+ New")
