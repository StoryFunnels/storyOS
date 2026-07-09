---
id: MN-040
title: Lookup fields — show a related record's field through a relation
status: done
depends_on: [MN-018]
size: L
---

**Problem (founder, 2026-07-09):** there is no way to surface a related record's data on this database — e.g. show the Client's `Contact Email` on each Project. Users duplicate data instead.

**Research.** Fibery: "Lookup" — pick one of the database's relations, then a field of the related database; value is read-only and live (changes on the source reflect immediately); chainable one level. Notion: "Rollup" with aggregation `Show original` covers the same case — property config = (relation property, target property). Airtable: "Lookup" identically. Common shape: **config is (relation field, target field), value is computed at read time, never written, rendered with the target field's display type**.

**Design.**

- New field type `lookup`, creatable when the database has ≥1 relation. Config: `{ relation_field_id, target_field_api_name }`.
- **Read-time resolution** in the records read path (list/get/query responses): for each lookup field, take the linked record ids from the relation field (already embedded as chips), batch-load the target values (one query per target database, not per record), and project `values[lookup.api_name] = single ? value : value[]`.
- Writes to a lookup value are rejected by the validator; the value never persists in `records.values` (no staleness).
- One-to-many relation → scalar; many-to-many → array rendered as a joined list.
- UI: type picker shows Lookup (with a "needs a relation" empty state); config UI = relation select → field select (excludes title? no — title allowed, types relation/lookup excluded to avoid chains in v1). Cells and property rows render read-only with the target field's `CellDisplay`; column header gets a small lookup glyph.
- Filtering/sorting by lookup values: **out of scope v1** (documented); the query compiler ignores lookups.
- Deleting the underlying relation or target field cascades: lookup fields pointing at them are deleted with a note in the API response.

## Acceptance criteria

- [ ] `lookup` type creatable via API + UI with `{relation_field_id, target_field_api_name}` validated (relation must belong to the database, target field must exist on the related database, no lookup-of-lookup)
- [ ] Record reads embed resolved lookup values with batch loading (no N+1); writes to lookups are 422
- [ ] Renders read-only in table cells and entity property rows using the target type's display
- [ ] Deleting the relation or the target field removes dependent lookups (covered by test)
- [ ] Integration tests: one_to_many scalar, many_to_many array, live update after source edit, validator rejections
