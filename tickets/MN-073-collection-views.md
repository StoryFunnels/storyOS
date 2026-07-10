---
id: MN-073
title: Collection field views — filter, sort, and color styling for relation/lookup lists
status: todo
depends_on: [MN-072]
size: L
---

A to-many relation on an entity page (e.g. a project's 105 issues) renders as an undifferentiated wall of titles. It needs the same view controls a database gets, scoped to the collection.

## Design
- Per-collection view config stored on the relation field's `config.collection_view` (merged): `{ filters, sorts, color_by, limit }`.
- **Filter & sort** the linked records by their own fields (reuse the filter AST + sort UI from table views, fed the target database's fields).
- **Color** each row by a select field on the target database (`color_by`), rendering the option color as a dot/stripe — same option colors used elsewhere.
- Builds on MN-072's 20-cap + expand.

## Acceptance criteria
- [ ] A collection can be filtered and sorted by the linked database's fields; config persists on the field
- [ ] Rows can be colored by a target select field, using its option colors
- [ ] Verified in the browser on a 100+ item collection
