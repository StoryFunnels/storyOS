---
id: MN-083
title: Table columns — drag-to-reorder + pin (freeze) the first column
status: done
depends_on: [MN-016]
size: L
---

Bug: table columns can't be reordered by drag-and-drop, and the first (Name/title) column isn't pinned. Founder: first column should be frozen by default with an unpin option.

## Design
- Drag column headers to reorder (dnd-kit horizontal), writing field `position` (the table's order) — this is the table's own order, distinct from entity zones.
- Freeze the first column: `position: sticky; left: 0` on the title cell + header, with a subtle shadow. Pinned by default; a header menu toggle unpins (store per-view or per-database config, e.g. `config.pinned_first`).

## Acceptance criteria
- [x] Drag a column header to reorder; order persists
- [x] First column is frozen on horizontal scroll by default; can be unpinned
- [x] Verified in browser (with enough columns to scroll)
