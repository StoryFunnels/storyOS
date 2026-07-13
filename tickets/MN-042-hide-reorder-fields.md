---
id: MN-042
title: Hide and reorder fields — on entity pages and every view
status: done
depends_on: []
size: M
---

**Problem (founder, 2026-07-09):** entity pages ("cards") show every field in creation order, forever. There is no way to hide a field (without deleting it) or to re-order fields. Table views have a "Hide fields" toolbar, but boards and entity pages have no visibility control, and nothing anywhere can reorder.

**Research.** Notion: page properties drag-reorder (persisted per database for everyone) and per-property visibility — "Always show / Hide when empty / Always hide" — with hidden ones collapsed behind an "N more properties" expander. the reference tool: entity view layout is configurable per database (fields can be hidden/re-arranged for everyone). Airtable: per-view field visibility + drag order in the row expander. Synthesis: **order is schema-level (one truth, drag anywhere), visibility is layered — per view for grids/boards, per database for the entity page, hidden ≠ deleted and always recoverable via an expander**.

**Design.**

- **Reorder** (creator): drag property rows on the entity page by a grip handle → persists `field.position` (API already supports `PATCH field {position}`) → same order drives table default column order. Field list everywhere sorts by position.
- **Hide on entity page** (creator, per database — everyone sees the same layout): property-row ⋯ menu gains "Hide on record page"; hidden fields collapse under an "N hidden fields" expander at the panel bottom (Notion-style), where each row offers "Show". Persisted as `entity_hidden: true` in the field's config (all config schemas get the shared optional key; no migration).
- **Boards**: view-toolbar gains the same "Hide fields" control tables have, driving `card_field_ids` (currently editable nowhere in the UI).
- Title cannot be hidden; hiding never affects the API payload — it is purely presentation.

## Acceptance criteria

- [ ] Property rows drag-reorder on the entity page and persist via field position; tables pick up the same order
- [ ] "Hide on record page" + hidden-fields expander with per-field "Show"; persisted in field config, applies to all members
- [ ] Board views can choose card fields from the toolbar (same interaction as the table's Hide fields)
- [ ] Title excluded from hiding; guests/editors see the layout but no controls below creator access
