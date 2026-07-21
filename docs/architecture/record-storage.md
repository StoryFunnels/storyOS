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

## Sorting by a computed field (MN-260)

`values` never holds formula/rollup/lookup output — those are computed at read
time by `attachFormulas`/`attachRollups`/`attachLookups`, **after** the SQL page
(and its keyset-cursor `ORDER BY`) has already run. That makes them un-sortable
by construction: the query layer can't `ORDER BY` a value that doesn't exist
until after the page is fetched.

**Decision:** materialize the sortable subset into a second JSONB column,
`records.computed_values` (same key convention as `values` — field UUID), written
by the server only, on the record's own write (formula) or on a related
record's/relation's change (rollup — see below, #267). `fieldExpr()`/the keyset
cursor then read it exactly like a stored field — no second (offset) pagination
mode, no branch in the cursor-comparison logic itself. `SORTABLE`
(`records.service.ts`) gains `formula` on that basis, and later `rollup` (#267).

**Scope at the time this was written: formula only, and only the
same-record-only subset.** The spike found **no existing
recompute-on-related-record-change plumbing for rollups** — `attachRollups` was
a pure read-time, per-fetched-page computation; there was no rollup subscriber
on `DomainEventsService`. Rollup materialization needed genuinely new
cross-record dependency tracking, tracked as a follow-up (#267) — **built below,
not deferred any further.**

A formula can reference a `lookup` or `rollup` field (`FieldsService.formulaTypeOf`
allows it, and it's an exercised path — see "formulas reference rollups" in
`rollups.test.ts`). Before #267, such a formula inherited the same cross-record
staleness rollups had and would have materialized a value computed as if the
related field were always null, so `formulaDependsOnlyOnOwnRecord` excluded any
formula reaching into either a `lookup` or a `rollup`. Now that rollup has its
own real invalidation plumbing (below), that exclusion is lifted for `rollup`
specifically — `lookup` remains excluded (no materialization/invalidation
plumbing exists for it). The web sort builder mirrors this exclusion client-side
(`isSortableFormula`, `sort-config.ts`) so the picker doesn't offer a sort that
would 422.

**Recompute path (formula):** `RecordsService.materializeFormulas` runs after a
record's own create/update transaction commits (awaited, not fire-and-forget,
so a query issued immediately after a write already sees the fresh value) and
after a formula field is first created (`materializeFormulaFieldForAllRecords`
backfills every existing record — otherwise sorting by a brand-new formula
field would show every pre-existing record as null until it happened to be
touched again). Both paths are isolated: a materialization failure never fails
the write the caller is waiting on, same posture as `DomainEventsService`
listeners. `computed_values` is written with a jsonb merge (`||`), not a full
replace, since rollup materialization (below) writes into the same column
independently — a full replace from either side would silently erase the
other's keys.

**Staleness bound (formula):** near-immediate, not "eventually" — the write
that changes a formula's own inputs is the same write that recomputes it,
awaited in the same request. The one gap: if the *isolated* recompute step
itself throws (rare — it's pure evaluation over already-validated values), the
materialized value is left stale until the record's next successful write;
nothing retries it in the background. A formula field added to an existing
database gets its backfill synchronously as part of the field-create response
(so it may make that response slower on a large database — acceptable for now,
a background job is the natural next step if that matters at scale).

## Rollup materialization (MN-267)

Unlike formula, a rollup's inputs live on OTHER records, reached through a
relation (`record_links`). Its materialized value can go stale for two
different reasons, so there are two independent invalidation triggers, both
implemented in `RecordsService` and wired through the existing after-commit bus
(`DomainEventsService`) via a new subscriber — mirroring `AutoLinkSubscriber`'s
shape, not a second storage or dispatch mechanism:

1. **A related record's own field changes** (e.g. a linked Time-Off record's
   `days` field). `RecordsService.invalidateRollupsForChange` (case a) walks
   every relation the changed record's database participates in, finds any
   rollup on the *other* side that reads through the reverse relation field and
   targets the field that changed (a `count` rollup always qualifies — it cares
   about link membership, not field values), and recomputes it for whichever
   other-side records are currently linked to the changed record.
2. **A relation's link membership changes** (a relation field is written via
   `update()`/`create*()`, or a chain of relation edges is set). `writeLinks()`
   captures the exact before∪after other-side record ids **at write time**,
   before its replace-delete runs — never reconstructed from `record_links`
   after the fact, so an unlink is never missed. That set travels on the domain
   event as `linkedRelations` and drives case (b): recompute this record's own
   rollup through the field that just changed, *and* the affected other-side
   records' rollup through the relation's reverse field
   (`relations.fieldAId`/`fieldBId` carry both sides' field ids directly, no
   extra lookup needed).

**Recompute + persist:** `RecordsService.recomputeRollupsForRelationField`
does one grouped aggregate SQL query per rollup field per chunk (never N+1 per
record) and merges the result into `computed_values` the same way formula does.
It also re-runs `materializeFormulas` for the same chunk afterward, so a
formula-over-rollup (now sortable — see above) refreshes in the same pass
rather than waiting for that record's own next write.

**Fan-out bound:** `recomputeRollupsForRelationField` processes affected
records in chunks of 500 (`CHUNK`), same constant `materializeFormulaFieldForAllRecords`
uses for its backfill. `RollupInvalidationSubscriber` (mirroring
`AutoLinkSubscriber`) always calls it fire-and-forget from the domain-event
handler — never awaited by the write that triggered the change — so a
highly-connected relation's fan-out is bounded per chunk/round-trip, not a
synchronous O(n) block in the triggering request's response path. A brand-new
rollup field is backfilled the same way (`recomputeRollupFieldForAllRecords`,
called from `FieldsService.create`), chunked identically.

**Staleness bound (rollup): bounded by one after-commit event-loop tick plus
however long the fire-and-forget recompute chunk takes to run — not
"eventually," and not synchronous either.** Concretely: the triggering write
(the related record's own update, or the relation-link write) commits and
returns to its caller *before* the rollup recompute runs — a query issued in
the same millisecond as that response can still observe the pre-cascade value.
The event bus dispatches synchronously within the same process immediately
after commit, and the subscriber's `void`-called recompute is typically
sub-second for the chunk sizes this fan-out bound targets (documented, not
promised, since it depends on chunk count and DB load). Contrast with
formula's bound (same request, same await) — rollup's is deliberately one step
looser because the change here originates on a *different* record than the one
being sorted. If the isolated recompute step itself throws, the same posture
as formula applies: the materialized value stays stale until the next
qualifying change re-triggers the cascade; nothing retries it in the
background.

**Known gap, pre-existing and not closed by #267:** `AutoLinkService` and
`RecordsService.duplicate()`'s link-copy step both write `record_links`
directly, bypassing both `RecordsService.writeLinks()` and `RelationsService`'s
add/replace/removeLinks — the two places `record_linked`/`record_updated` (with
`linkedRelations`) get emitted from. `auto-link.subscriber.ts` already
documented this exact gap for AutoLink before #267 ("creates record_links but
emits no domain event, so there is no cascade to guard against"). A rollup
depending on a relation populated by auto-link or record duplication will
display correctly (`attachRollups` is still read-time and doesn't care how the
link got there) but its *materialized* sort value won't refresh until the
rollup-bearing record (or a record it's linked to) is next written through one
of the two event-emitting paths above.

## Migration path if JSONB hits limits

Locked in ADR-0002 so contributors don't relitigate:

1. **Per-field expression indexes** on hot fields (`CREATE INDEX ... ((values->>'f1')::numeric) WHERE database_id = ...`) — no schema change, can be automated.
2. **Generated columns** on `records` for hot typed fields.
3. Full move to **dynamic physical tables** behind the existing `RecordsRepository` seam — the public API never changes. This is why the compiler and repository must stay isolated modules.
