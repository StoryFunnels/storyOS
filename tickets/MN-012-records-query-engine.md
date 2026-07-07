---
id: MN-012
title: Records query engine — filter AST → SQL, sorts, cursors
status: done
depends_on: [MN-011]
size: L
---

**The walking skeleton completes here.** `POST /databases/:id/records/query`: filter AST zod schema (and/or nesting ≤3, ≤50 conditions), the isolated AST→SQL compiler with per-type casts, multi-sort (≤3) with `id` tiebreaker, keyset cursors, `q` title search (pg_trgm ILIKE), relative date values (`today`, `next_7_days`, `this_month`), `"me"` user token, limits. Spec: [docs/architecture/record-storage.md](../docs/architecture/record-storage.md) + op×type matrix in [api-conventions.md](../docs/architecture/api-conventions.md).

## Acceptance criteria

- [ ] Full op×type matrix implemented; every op has ≥1 SQL-compilation unit test and ≥1 integration test; invalid op-for-type → 422
- [ ] Cursor pagination pages stably under concurrent inserts (integration test)
- [ ] Injection via field values/ops/ids impossible — fully parameterized; field ids validated against live fields before compilation (explicit test)
- [ ] `q` search hits trigram index (EXPLAIN checked once, documented)
- [ ] p50 < 100 ms on a seeded 50k-record database for a representative filter+sort query
- [ ] The compiler and repository stay isolated modules — no query logic in controllers (review gate)
