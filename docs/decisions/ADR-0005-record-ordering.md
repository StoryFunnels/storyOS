# ADR-0005: Record ordering — one fractional index per database

- **Status:** accepted
- **Date:** 2026-07-07

## Context

Kanban within-column order and table default order need manual ordering. Options: a per-view order table (Notion's approach — each view has its own manual order) or a single order per record per database.

## Decision

One `records.position` fractional-index string (LexoRank-style, `fractional-indexing` npm) per record, shared by all views of that database. Kanban within-column order = records in that column sorted by `position`; a drop writes a key between the two column-neighbors (consistent with the global sequence). **`POST /records/:id/move`** takes `{before_record_id | after_record_id, values?}` so a cross-column kanban drag (position + group-field change) is one atomic call. Sorted views ignore `position` entirely. A background rebalance handles key-length exhaustion.

Rejected for v1: per-view order table — more correct, but doubles write/storage surface and makes "where does a new record land?" ambiguous across N views. Linear ships shared manual order; it's predictable and cheap.

## Consequences

- Reordering in one view visibly reorders "manual order" everywhere — documented behavior.
- Upgrade path: add a per-view order table later; the `move` endpoint shape doesn't change (it gains a `view_id` context), so the public API survives the upgrade.
- Views with an active sort disable drag-reordering (UI communicates this).
