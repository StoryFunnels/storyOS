---
id: MN-022
title: Record ordering + move endpoint
status: done
depends_on: [MN-011]
size: S
---

Fractional-indexing utilities (`fractional-indexing` npm) + `POST /records/:id/move` taking `{before_record_id | after_record_id, values?}` — one atomic call for a kanban drop (position + group-field change together). Rebalancing fallback when keys exhaust precision. Per [ADR-0005](../docs/decisions/ADR-0005-record-ordering.md): one order per database, sorted views ignore it.

## Acceptance criteria

- [ ] Move between two neighbors yields a stable total order under repeated drags (property-based test)
- [ ] `move` with `values` (e.g. new select option) is atomic — no state where one applied without the other
- [ ] Default table order respects `position`; new records append at the end
- [ ] Rebalance path triggered and tested at key-length threshold
- [ ] Move emits a `record.updated` activity event with the field diff (not position noise)
