---
id: MN-020
title: Views backend
status: todo
depends_on: [MN-012]
size: M
---

`views` CRUD with the zod-validated `config` (filter AST, sorts, group_by_field_id, hidden_field_ids, card_field_ids, column_widths). Decision (from planning): the view is a **saved preset** — the client reads the view config and sends the full query to `/records/query` itself; the server stays dumb. Backfill MN-009's default-view stub so every database always has ≥1 view (last one undeletable).

## Acceptance criteria

- [ ] View CRUD with config validation (bad field ids / ops → 422)
- [ ] References to deleted fields are dropped defensively at read time (integration test: delete field, view still loads)
- [ ] `group_by_field_id` must reference a single-select field for board views
- [ ] Every database keeps ≥1 view; deleting the last → 409
- [ ] Guests can read views, not create/modify them
