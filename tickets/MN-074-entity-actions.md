---
id: MN-074
title: Entity header actions — duplicate, copy link, delete + field-manager popover
status: done
depends_on: [MN-072]
size: M
---

the reference tool's entity card has an Actions menu (Duplicate, Copy link, Watch, Configure Fields, Delete…) and a "select which fields to show" popover. Our record page has none of that. Founder ask: duplicate a record, copy link, and a header field picker; star/favorite is separate (MN-075).

## Design
- **Duplicate** — backend `POST /records/:rec/duplicate`: clones scalar values + the description document, copies single-reference and many-to-many links, but NOT owned collections (a child can't have two parents — one_to_many side b is skipped). Title gets " (copy)". Returns the new record; UI navigates to it.
- **Header Actions ⋯** — Duplicate, Copy link (writes the record URL to clipboard), Delete (soft-delete → back to the database).
- **Fields popover** — a header "Fields" button opening every non-system field with a show/hide toggle (writes `entity_hidden`), so visibility is managed in one place, not only per-field ⋯.

## Acceptance criteria
- [x] Duplicate creates a copy with the same scalar values, description, single-ref/m2m links; owned collections are not reparented — API test + browser
- [x] Copy link puts the record URL on the clipboard; Delete soft-deletes and returns to the database
- [x] Fields popover toggles field visibility on the record; verified in browser
