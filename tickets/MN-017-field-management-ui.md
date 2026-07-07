---
id: MN-017
title: Field management UI
status: todo
depends_on: [MN-016]
size: M
---

Schema editing from the table: "+" column header → add-field dialog (type picker + type-specific config); rename/edit; the type-change flow surfacing the dry-run lossy-conversion warning from MN-010; select-options editor (labels, colors, drag-reorder); field delete with usage-count confirm. Relation fields get their creation flow in MN-019.

## Acceptance criteria

- [ ] All v1 non-relation types creatable from the UI with their config panels
- [ ] Type change shows the dry-run lossy count and requires explicit confirm before applying
- [ ] Options editor round-trips labels/colors/order; kanban column order will follow option order
- [ ] Field delete confirm shows how many records carry a value
- [ ] Table refreshes schema (new/renamed/removed columns) without a page reload
