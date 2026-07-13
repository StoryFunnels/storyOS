---
id: MN-064
title: Rollup fields — aggregate a related database's values (sum/count/min/max/avg)
status: done
depends_on: [MN-040, MN-043]
size: L
---

**The enabler found three times in the the reference tool review:** vacation balances (allocation − sum of days), event budget vs actual (sum of expenses), pipeline value per stage (sum of opportunity amounts). Formulas (MN-043) can't aggregate relations; lookups (MN-040) project single values.

## Design (Notion Rollup / the reference tool aggregation formulas)
- New field type `rollup`, config `{ relation_field_id, target_field_api_name | null, op: 'count'|'sum'|'avg'|'min'|'max' }` — count works with no target field.
- Read-time resolution alongside lookups (`attachRollups` in the same pass — reuse the chip batching; aggregate over linked ids, target values loaded once per rollup field).
- Formulas may reference rollups (formula_type = number) — `{Allocation} - {Days Used}` closes the vacations story.
- Writes 422; cascade with relation deletion like lookups; UI = lookup config + op select.

## Acceptance criteria
- [x] rollup type: config validation, batch read-time aggregation, writes rejected, cascade on relation delete
- [x] Formulas can reference rollups; vacations balance recipe added to formulas docs
- [x] Cells/property rows render by op result (number); integration tests incl. count-with-no-target and empty-relation → 0 for count / null for others
