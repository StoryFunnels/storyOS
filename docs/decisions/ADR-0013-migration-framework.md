# ADR-0013: A shared migration framework + a first-class external-id primitive

- **Status:** partially implemented — see the note below
- **Date:** 2026-07-17
- **Source:** #198 (MN-236 shared import pipeline) and the importer research on #169–#172 (Airtable, Notion, Monday, Fibery). Grounded in the three importers that already exist (Linear, CSV, GitHub).

> **Implementation note (2026-07-21, #198).** `apps/api/src/migration-framework/`
> now holds the `SourceAdapter` contract, the IR types, the field-type mapping
> layer, the unified dry-run builder, chunked apply, and shared upsert/relation-link
> helpers — and the CSV (MN-052) and Linear (MN-066) importers are refactored
> onto it (`CsvSourceAdapter`, `LinearSourceAdapter`). **Deliberately deferred:**
> the DB-level `records.source_system`/`source_id` primitive from §1 — it's a
> schema migration, and landing one the same night several agents are shipping
> migrations in parallel was judged not worth the collision risk for a v1 that
> doesn't strictly require it. Idempotent re-import instead runs on an ordinary
> field (`external-id-upsert.service.ts`), which is what Linear already used.
> GitHub's importer was left untouched (out of #198's stated scope), and no new
> source (Airtable/Notion/Monday/Fibery, #169–#172) has been built yet — they
> still plug into the adapter interface as planned.

## Context

We have three importers — **Linear** (`integrations/linear.service.ts`), **CSV**
(`import/import.service.ts`), and **GitHub** (`integrations/github.service.ts`) —
and they share **zero framework code**. Each hand-rolls the same three things:
find-or-create the schema pack, upsert records, and (for two of them) a dry-run.
Worse, three real defects repeat across them:

1. **No external-id primitive.** Idempotency is done *by convention*: an importer
   writes the source id into an ordinary user field (`linear_id`; GitHub's
   `repo`+`number`) and re-finds it with `recordsService.query({filter:{field,op:'eq',value}})`.
   There is **no column** storing a source id and **no unique constraint** — so a
   concurrent or interrupted re-import can duplicate rows, and CSV can't dedup at all.
2. **No pagination.** Linear caps at `first: 250`, GitHub at `per_page=100` single
   page — larger sources **silently truncate**.
3. **Inconsistent dry-run.** CSV has a rich preview (warnings + sample), Linear has
   counts only, GitHub has none.

The research on the four competitors (see [importers.md](../architecture/importers.md))
shows they are structurally near-identical to import: pull schema, pull data,
map field types, collapse two-sided links into one paired relation, download
expiring attachments, apply idempotently by a stable source id. The differences
are auth, pagination style, rate-limit model, and rich-text extraction — not the
shape of the pipeline.

## Decision

### 1. A first-class external-id primitive (the load-bearing new piece)

Add to `records`:

- `source_system text` (e.g. `linear`, `github`, `airtable`, `csv:<import-id>`)
- `source_id text` (the stable id in that system)
- a **unique partial index** `(database_id, source_system, source_id) where source_id is not null`.

This gives a **DB-level dedup guarantee**, replaces three hand-rolled
query-by-field upserts, and lets the dry-run split *create* vs *update*. Existing
importers migrate onto it (their `linear_id`/`repo+number` fields can stay as
visible columns, but idempotency moves to `source_id`).

### 2. A source-agnostic intermediate representation (IR)

Every importer is just *source API → IR*:
`Source { containers[], databases[], fields[], records[], relations[], attachments[] }`,
all keyed by source ids. The framework consumes the IR; importers never call the
records/fields/relations services directly.

### 3. The pipeline the framework owns

`map → dry-run → chunked, resumable apply`, in this order:

1. **find-or-create** spaces → databases → fields (idempotent by a stable key).
2. **records** in batches via the existing `recordsService.createBatch(...,{suppressAutomations:true})` — generalising CSV's 500-row loop so Linear/GitHub stop looping single `create`.
3. **relations in a second pass** (all targets must exist first).
4. **attachments** downloaded + rehosted (3 of 4 sources have **expiring URLs**).

Plus shared helpers the importers duplicate today: **upsert-by-source-id**, the
**select label→option-id** map, a **fetch-all-pages** cursor loop, and the
`workspaces.settings.<provider>` config store.

### 4. A unified dry-run contract

`{ will_create, will_update, new_fields[], relation_pairs[], lossy[], warnings[], sample[] }`
— counts + the field-mapping/relation-pairing preview + a **lossy-conversion list**
(computed fields, unmapped types), before any write. `will_update` is only possible
because of the external-id primitive (§1).

### What stays per-importer

Auth (PAT / OAuth / GraphQL token), pagination style (offset vs cursor vs
command-DSL), the rate-limit model (Airtable 5 req/s; Monday complexity budget;
Notion ~3 req/s; Fibery TBD), rich-text extraction → markdown, and the
source→field mapping table.

### Sequencing

Build the IR + framework against **Fibery first** (closest data model, cleanest
relations, near-direct workflow-state map — ADR-0011), then **Airtable**
(well-documented REST, stable ids), then **Notion** (blocks + the `2025-09-03`
data-sources split), then **Monday** last (GraphQL complexity budget + formula/mirror
values historically unreadable).

## Consequences

- **One dedup mechanism, enforced by the database** — the single most valuable
  change; kills the duplicate-on-reimport class of bug and unlocks true upsert
  for CSV.
- **Correctness fix for free:** the shared pagination loop closes the silent
  truncation in Linear and GitHub.
- **Cost:** a migration (two columns + a partial unique index) and refactoring
  the three existing importers onto the IR + framework — done incrementally so
  each importer keeps working through the transition.
- **Escape hatch:** importers can still special-case anything the IR can't
  express (e.g. Monday's unreadable formula values) by writing static values.
- **Rejected — keep per-importer copies:** guarantees the duplicate-on-reimport
  bug persists and every new importer (four are planned) re-pays the same cost.

Implementation lands as its own ticket (#198); the four competitor importers
(#169–#172) build on this framework, each contributing only its source client +
mapping table.
