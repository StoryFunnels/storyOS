# Record storage — JSONB mechanics

Decision locked in [ADR-0002](../decisions/ADR-0002-record-storage-jsonb.md): one `records` table with JSONB `values` keyed by field UUID. This doc is the implementation reference.

## Why JSONB (short version)

- **EAV** (`record_values` rows per field): maximal integrity, but every read is a pivot and every multi-field filter is N self-joins. Wrong trade for v1.
- **Dynamic physical tables** per user database: best query performance, but online DDL on user actions, migration hell, pool-wide DDL locks, and ORM tooling can't model it. That's what you migrate *to* at 10M-row scale, not where you start.
- **JSONB**: one table, no DDL at runtime, good-enough querying at self-host scale, and a clean escape hatch (below).

## Storage

`records.values :: jsonb`, object keyed by field UUID. Per-type encodings:

| Field type | JSON encoding |
|---|---|
| text, url, email | string |
| number | JSON number |
| checkbox | boolean |
| date | ISO-8601 string (lexicographic = chronological) |
| select | option UUID string |
| multi_select | array of option UUIDs |
| user | user UUID (array if multi) |
| title | promoted to real `records.title` column |
| relation | **not stored here** — `record_links` table |

## Write path — the value validator

Postgres stores anything; the **service layer is the schema enforcer**. One well-tested pure function in `packages/schemas` (`record-values.ts`) validates every incoming `values` payload against the live `fields` rows: type check, coercion, select-option existence, unknown-field rejection. Per-path 422s. PATCH merges keys; explicit `null` clears a key.

## Read path

Reads project through **live** fields only — orphan JSONB keys (from deleted fields) are invisible. Relation values are joined from `record_links` and returned as `{id, title}` chips (one-level `expand` supported).

## Filtering & sorting — the query compiler

One isolated module (`query-compiler.ts`) translates the filter AST into parameterized SQL with type-aware casts derived from the field's declared type:

```sql
-- number gt          ((values->>'f1')::numeric > $1)
-- date before        (values->>'f2') < $1              -- ISO strings compare correctly
-- select eq          values->>'f3' = $1
-- multi_select has   values->'f4' ? $1
-- text contains      values->>'f5' ILIKE '%'||$1||'%'
-- is_empty           NOT (values ? 'f1') OR values->>'f1' IS NULL
-- relation has       EXISTS (SELECT 1 FROM record_links rl WHERE rl.relation_id = $1
--                            AND rl.from_record_id = records.id AND rl.to_record_id = $2)
```

Sorting: `ORDER BY (values->>'fx')::numeric NULLS LAST, id` — **always** append `id` as tiebreaker so keyset cursors are stable. Everything is parameterized; field ids are validated against the database's live fields before compilation (no identifier injection).

## Indexes

- `GIN (values jsonb_path_ops)` — equality/containment
- `btree (database_id, position)` — manual order
- `btree (database_id, created_at, id)` — default listing
- `GIN (title gin_trgm_ops)` — `q=` title search

Range filters/sorts on JSONB casts seq-scan within the `database_id` slice — fine at v1 scale (thousands to low-hundreds-of-thousands of rows per database, always pre-filtered by `database_id`). Performance bar: query p50 < 100 ms on a 50k-record database (MN-012 AC).

## Field lifecycle integrity

- **Delete field:** soft-delete (`fields.deleted_at`). Orphan keys in `values` are ignored by reads; a lazy cleanup job strips them — never blocks the user action. Views drop dead references defensively at read time. Deleting a relation-field deletes the relation + its `record_links` (both sides) after explicit confirm.
- **Type change:** small compatibility matrix only — anything→text (stringify); text→number/date (batch best-effort parse, unparseable→null, single transaction); select↔multi_select. Everything else = "delete & create new" (explicit, honest). API returns a **dry-run count** of lossy conversions before applying.
- **Select option delete:** dangling option ids resolve to null at read; optional "reassign to option X" parameter on delete.

## Migration path if JSONB hits limits

Locked in ADR-0002 so contributors don't relitigate:

1. **Per-field expression indexes** on hot fields (`CREATE INDEX ... ((values->>'f1')::numeric) WHERE database_id = ...`) — no schema change, can be automated.
2. **Generated columns** on `records` for hot typed fields.
3. Full move to **dynamic physical tables** behind the existing `RecordsRepository` seam — the public API never changes. This is why the compiler and repository must stay isolated modules.
