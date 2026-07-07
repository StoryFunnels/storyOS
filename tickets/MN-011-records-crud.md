---
id: MN-011
title: Records CRUD (JSONB) + value validator
status: done
depends_on: [MN-010]
size: L
---

The heart of the write path. `records` table (JSONB `values`, promoted `title`, fractional `position` appended at end on create, soft delete). The record-value validator as a pure function in `packages/schemas` (type check, coercion, select-option existence, unknown-field rejection). `RecordsRepository` seam — all record access flows through it ([ADR-0002](../docs/decisions/ADR-0002-record-storage-jsonb.md)). Batch create (≤100). Trash: list + restore endpoints, 30-day retention documented. Activity events for record create/update/delete/restore written in the same transaction (rendering comes in MN-027).

## Acceptance criteria

- [ ] Create/PATCH validate every value against live fields with per-path 422s; PATCH merges keys; explicit null clears
- [ ] Reads project through live fields only — orphan JSONB keys from deleted fields are invisible
- [ ] Soft delete + restore round-trip; trashed records excluded from all lists
- [ ] Batch create ≤100 records atomically; >100 → 422
- [ ] `created_by`/`updated_by` stamped; activity rows written transactionally
- [ ] Dense unit suite on the validator (every type × valid/invalid/coercion) + integration CRUD tests
