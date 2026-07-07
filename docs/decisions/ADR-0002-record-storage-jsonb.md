# ADR-0002: Record storage — single table with JSONB values

- **Status:** accepted
- **Date:** 2026-07-07

## Context

Users define databases and fields at runtime. Three storage strategies exist: (a) EAV rows per value, (b) one `records` table with a JSONB `values` column keyed by field id, (c) dynamic physical tables per user database. We need good-enough query performance at self-host scale (thousands to low-hundreds-of-thousands of rows per database), no runtime DDL, and a credible growth path.

## Decision

**(b) JSONB.** `records(id, database_id, title, values jsonb, position, ...)`:

- Title promoted to a real column (search, pickers, activity rendering).
- Relation values are NOT in `values` — they live in a `record_links` join table (one row per link, both directions served, real FKs, cardinality via partial unique indexes).
- The service layer is the schema enforcer: a shared pure validator in `packages/schemas` checks every write against live field definitions.
- A single isolated **query compiler** translates the filter AST into parameterized SQL with type-aware casts; all record access goes through a `RecordsRepository` seam.
- Indexes: `GIN (values jsonb_path_ops)`, `btree (database_id, position)`, `btree (database_id, created_at, id)`, `GIN (title gin_trgm_ops)`.
- Field lifecycle: soft-delete fields, ignore orphan JSONB keys at read, lazy cleanup; narrow type-change compatibility matrix with dry-run lossy counts; dangling select-option ids resolve to null.

Rejected: EAV (every read a pivot, every filter N self-joins); dynamic tables (runtime DDL, migration and pooling hazards, ORM can't model it — it's the destination at big scale, not the start).

## Consequences

- Range filters/sorts on JSONB casts seq-scan within the `database_id` slice — acceptable at v1 scale; performance bar: p50 < 100 ms on 50k records.
- **Escape hatches, in order:** (1) per-field expression indexes on hot fields — no schema change; (2) Postgres generated columns for hot typed fields; (3) full migration to dynamic physical tables **behind the `RecordsRepository` seam** — the public API never changes.
- Corollary: the query compiler and repository must remain isolated modules, never smeared through controllers. PRs violating this get bounced.
