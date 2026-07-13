# Migrating your data

StoryOS imports CSV — and the reference tool exports every database to CSV, including relation columns as
**target names**. That pair is the whole migration path.

## Export from your current tool

For each database: open its grid view → `⋯` → **Export** → CSV. You get one file per database
with entity fields as columns; relation fields export as comma-separated target names; selects
export as labels; dates export ISO.

## Import order matters

Relation columns match records **by title**, so the target database must be populated first:

1. **Install the closest template pack** (or create the schema by hand) so relations exist.
   The importer links through *existing relation fields* — it does not create relations.
2. Import "leaf" databases first (the ones others point AT): Clients before Projects,
   Projects before Tasks, Topics before Articles.
3. Import the source-side databases; map their relation columns to the relation field and
   the importer resolves each cell by title. Misses and ambiguous titles become warnings —
   the row still imports, the cell stays empty.

## The wizard

Database `⋯` menu → **Import CSV…**

1. **Upload** — delimiter (`,` `;` tab) and encoding are detected.
2. **Map columns** — each CSV column goes to: the record **title** (exactly one), a **new field**
   (type suggested by inference over the first 1000 rows), an **existing field**, a **relation**
   (match by title), or *Don't import*.
3. **Check import** — a dry run: how many rows will import, which fields get created, every
   warning with its row number. Nothing is written yet.
4. **Import** — records are created in chunks of 500. One bad cell never loses a row: the cell
   is dropped with a warning instead.

## Field-type mapping

| Source type | StoryOS type | Notes |
|---|---|---|
| Text (one-line) | Text | |
| Rich Text | — | does not migrate in v1 (export is plain text; import as Text if useful) |
| Number | Number | thousands spaces and `,` decimals normalized |
| Date / Date range | Date | ranges lose the end date in v1 |
| Single-select / Workflow state | Select | options created from distinct values, labels preserved |
| Multi-select | — | import as Text in v1, split later |
| Checkbox | Checkbox | true/yes/1 |
| URL / Email | URL / Email | |
| Relation | Relation (match by title) | relation must exist in StoryOS first |
| People | — | v1: skip; invite users first, assign afterward |

## Known non-migrations (v1)

Rich-text documents, comments, files, automation rules, user assignments. Re-running an import
creates duplicates (no upsert) — import once, verify, and use the created-records activity
event if you need to identify an import batch.

## Worked example (JCM)

1. Install the **Client Work** pack → Clients/Contacts/Projects/Tasks with relations wired.
2. Export your four source databases to CSV.
3. Import `clients.csv` into Clients (Name → title, Status → existing select…).
4. Import `projects.csv` into Projects; map the `Client` column to the Client relation.
5. Import `tasks.csv` into Tasks; map `Project` to the Project relation, `State` to the
   existing State select (labels must match — rename options first if they differ).
6. Spot-check counts against the source, then invite the team.
