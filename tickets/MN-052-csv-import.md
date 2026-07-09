---
id: MN-052
title: CSV import — move the team's data in (with a Fibery migration guide)
status: todo
depends_on: []
size: L
---

**Problem.** "We need to make our team move inside" — and the team's working data lives in Fibery today. The API can batch-create, but nobody migrates a company through curl. Import quality decides whether the move-in happens at all; a bad first import (mangled types, lost relations) burns trust permanently.

## Research

- **Fibery export**: every database exports CSV — entity fields as columns, **relations as comma-separated target names**, dates ISO, selects as labels. So CSV is precisely the bridge format, and "match relation cells by target title" is the key trick.
- **Notion import**: CSV → new database; types inferred; zero mapping UI (fast but wrong types stick — we want the mapping step).
- **Airtable import**: into existing table with per-column mapping (existing field / new field / skip) + preview of first rows.
- **Linear importer**: the gold standard flow — upload → map → **dry-run summary with per-row issues** → import → report. The dry run is what makes people trust it.

**Synthesis:** upload → parse + infer → mapping table → dry-run with per-row errors → chunked import; relations resolve by target title; a written Fibery-specific runbook.

## Design

### Parsing & inference (server-side)

- Multipart CSV ≤ 10MB, UTF-8 (+ BOM tolerated), delimiter sniffing (`,` `;` `\t`), quoted fields, embedded newlines — use a battle-tested tiny parser (`csv-parse`) rather than hand-rolling; first row = headers (option to disable).
- **Type inference** per column over the first 1000 data rows:
  - all `true/false/yes/no/1/0` (≥95%) → checkbox
  - all parse as number → number
  - all parse as ISO/`dd.mm.yyyy` dates → date
  - ≤24 distinct non-empty strings AND ≥2 repeats → select (options = distincts, palette auto-colored)
  - looks like emails / urls (≥90%) → email / url
  - else text
- Inference produces a *suggested* mapping; the user always confirms.

### Mapping payload

```
mapping: Array<{
  column: string,
  to: { kind: 'existing', field_id }        // must be type-compatible
     | { kind: 'new', display_name, type }  // creatable types only
     | { kind: 'relation', field_id }       // match by target title
     | { kind: 'title' }                    // exactly one required
     | { kind: 'skip' }
}>
```

### Endpoints

- `POST /workspaces/:ws/databases/:db/import` — body: file + mapping + `dry_run: boolean`.
  - **Dry run** returns `{ rows, will_create, new_fields: […], warnings: [{row, column, message}] (first 100), sample: first 5 mapped records }`. Warnings, not errors: unparseable cell → imports as empty; unmatched relation title → empty + warning; row with empty title → skipped + warning.
  - **Commit**: creates new fields first, then records in **chunks of 500** through the existing validator (invalid values → cell dropped + warning, row still imports); relation columns resolved via one preloaded `title → id` map per target database (exact match, case-sensitive first then case-insensitive fallback; ambiguous → warning). Import runs **without firing automations** (MN-047 contract) and writes one `records.imported` activity event with counts.
  - Response: `{ created, warnings_count, rejected_rows_csv_token }` — a token to download rejected/warned rows as CSV.
- `POST /workspaces/:ws/spaces/:space/databases/import-new` — name + file + (optional) edited inference → creates the database then delegates to the same import path. 
- Import is member+ (guests never), and counts against a 3-concurrent-imports cap per workspace.

### Wizard UI (4 steps, a dialog with progress header)

1. **Upload** — drop zone; parse errors (encoding/oversize) shown here; entry points: "New database → Import CSV" tab in the new-database dialog, database ⋯ menu → "Import records", and the template gallery's Blank section ("Start from your data").
2. **Map columns** — table: CSV column · sample values (3) · destination select (existing fields type-filtered / "＋ New field (type ▾)" / Skip); title mapping highlighted until satisfied; relation destinations show "matches by title" hint.
3. **Dry run** — summary card (N rows → N records, M new fields, K warnings listed grouped by kind, expandable); Back to fix mapping or Import.
4. **Import** — progress (chunk count), then done state: created count, warnings, "Download issues CSV", link to the database.

### Docs deliverable — `docs/product/migrate-from-fibery.md`

- Export steps in Fibery (per database → CSV).
- **Import order rule**: targets before sources (Clients before Projects before Tasks) so relation titles resolve; StoryOS relations must exist before importing the source side (create schema via template or manually first — recommended path: install the closest template pack, then import into its databases).
- Field-type mapping table (Fibery type → StoryOS type → caveats), known non-migrations v1: rich-text documents, comments, files, automation rules, users (invite them first so person columns can be mapped manually afterward — person fields import as skip+warning in v1).
- A worked JCM example end-to-end.

## Implementation plan

1. Parser + inference module with unit tests over messy fixtures (mixed encodings, quoted newlines, semicolons, 24-distinct select edge, date formats).
2. Import service: mapping validation, dry-run, chunked commit, relation title resolution, warning collection, rejected-rows CSV; suppress-automations flag plumbed (no-op until MN-047).
3. Endpoints + caps + SDK regen; integration tests: into-existing with all mapping kinds, import-new with inference, relation hit/miss/ambiguous, empty-title skip, 500-chunk boundaries.
4. Wizard UI (4 steps) wired to all 3 entry points.
5. Docs runbook with the JCM worked example; link from wizard step 1.
6. Browser-verify with a real Fibery export of one JCM database.

## Edge cases

- Duplicate titles in the target database when resolving relations → ambiguous warning, cell left empty (never guess).
- Column mapped to select with >24 new distinct values at commit time (beyond inference sample) → options created anyway up to 100, then warning per extra value.
- Re-running the same import → duplicates by design (no upsert in v1); docs call it out; "delete imported records" escape hatch = the import activity event stores created ids → future "undo import" is possible, store them now.
- 10MB × long rows memory: stream-parse, never load the whole parse into memory at once.

## Out of scope

Upsert/dedupe by key column, scheduled/recurring imports, Excel files, direct Fibery API importer (v2 — CSV path first proves the mapping engine), person-field matching by email (explicitly v1.1 — needs invited users + email column matching).

## Acceptance criteria

- [ ] Parse + inference module tested over messy fixtures; delimiter/BOM/quoted-newline safe; streaming
- [ ] Import into existing DB: all five mapping kinds, dry-run with grouped warnings, chunked commit, per-cell degradation (never lose a row over one bad cell), rejected-rows CSV download
- [ ] Import-as-new-database with confirmed inference; relation resolution by title with hit/miss/ambiguous semantics tested
- [ ] Wizard: upload → map → dry-run → import → report, reachable from 3 entry points; member+ only
- [ ] Imports don't fire automations; created ids recorded in the activity event
- [ ] docs/product/migrate-from-fibery.md with import-order rule, type table, JCM worked example
