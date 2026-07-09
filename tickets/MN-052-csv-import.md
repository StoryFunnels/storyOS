---
id: MN-052
title: CSV import — move the team's data in (with a Fibery migration guide)
status: todo
depends_on: []
size: L
---

**Problem.** "We need to make our team move inside" — and the team's data lives in Fibery today. The API can batch-create, but nobody migrates a company through curl. Import is the adoption gate.

**Research.** Notion import: CSV → new database, types inferred, preview before commit. Airtable: CSV into existing table with column mapping + "don't import" per column. Fibery **export**: every database exports CSV (entities incl. relation columns as names) — so CSV is precisely the bridge format. Linear importer: mapping UI + dry-run summary. Synthesis: **upload → parse + type inference → mapping table (each CSV column → existing field / new field with type / skip) → dry-run preview with per-row errors → import; relations map by target title**.

**Design.**

- API: `POST /databases/:db/import` (multipart CSV ≤ 10MB) with a `mapping` payload; two modes — `dry_run` returns {rows, creates, errors[{row, column, message}], sample}; commit creates records in batches of 500 reusing the existing validator; relation columns match target records by exact title (ambiguous/missing → per-row warning, cell left empty).
- Also `POST /databases/import-new`: create a database from CSV in one step (name + inferred fields: number/date/checkbox/select detection by value scan of first 1000 rows; ≤ 24 distinct strings → select).
- Web wizard (from "New database → Import CSV" and database ⋯ menu → "Import records"): upload → mapping table with type dropdowns + sample values → dry-run summary (n will import, m warnings listed) → import with progress → done state linking to the records; failures downloadable as CSV of rejected rows.
- **Docs deliverable:** `docs/product/migrate-from-fibery.md` — export each Fibery database to CSV, import order (targets before sources so relation titles resolve), field-type mapping table, known limits (documents/comments don't migrate in v1).

## Acceptance criteria

- [ ] Import into existing database with column mapping, dry-run, per-row errors, 500-row batches
- [ ] Import-as-new-database with type inference (number/date/checkbox/select/text) — covered by tests with a messy fixture CSV
- [ ] Relation columns resolve by target title; misses become warnings not failures
- [ ] Wizard UI: upload → map → dry-run → import → summary; rejected-rows CSV download
- [ ] docs/product/migrate-from-fibery.md written and linked from the wizard
