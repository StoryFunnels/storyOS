# Migrating your data

StoryOS imports CSV — and the reference tool exports every database to CSV, including relation columns as
**target names**. That pair is the whole migration path.

## Export from your current tool

For each database: open its grid view → `⋯` → **Export** → CSV. You get one file per database
with entity fields as columns; relation fields export as comma-separated target names; selects
export as labels; dates export ISO.

## Import order matters

A relation column matches records in the target database, so **the target has to be populated
first** — that constraint has not gone anywhere.

1. Import "leaf" databases first (the ones others point AT): Clients before Projects,
   Projects before Tasks, Topics before Articles.
2. Import the source-side databases and map each relation column. You can either point it at an
   **existing relation field**, or name a **target database** and let the import create the
   relation for you — so importing into a brand-new table works without wiring the schema up first.
3. Choose **which field on the target to match on**. The title is the default, but if your CSV
   carries a stable `company_id` alongside a display `company_name`, match on the id: it is the
   one that does not break when somebody renames a record.

Misses and ambiguous titles become warnings — the row still imports and the cell stays empty.

## The wizard

Database `⋯` menu → **Import CSV…**

1. **Upload** — delimiter (`,` `;` tab) and encoding are detected.
2. **Map columns** — each CSV column goes to: the record **title** (exactly one), a **new field**,
   an **existing field**, a **relation**, or *Don't import*.
3. **Check import** — a dry run: how many rows will import, which fields get created, how many
   links will be made, and every warning with its row number. Nothing is written yet.
4. **Import** — records are created in chunks of 500.

### Columns that already match a field are pre-selected

A `website` column pre-selects your existing **Website** field rather than proposing a second one.
The wizard shows you which columns it matched for you, so a pre-selection is never silent — check
them, because a wrong guess is harder to spot than no guess.

### What a new field can be

Every field type StoryOS can create, except the five a CSV cell cannot become: **lookup**,
**rollup**, **formula**, **button** and **attachment**. A file is not a cell, so an import that
"created" an attachment field would produce a column empty for every row.

So rich text, workflow, multi-select and person **do** import — they are new fields like any other.

### One bad cell does not fail the import

A malformed URL or email is dropped with a warning naming its row and column. The row still
imports, and everything else in it survives.

### If the import fails anyway

**A failed import leaves the database as it was.** Anything the run created — records first, then
the fields it added — is undone.

This matters more than it sounds. Schema changes and record writes are not one transaction, by
design, so that a large file does not hold a transaction open from beginning to end. Without the
undo, a failed run would leave its new fields behind and your retry would collide with them, with
no way out from inside the product.

### The failure message names the cell

Row, column and reason — not just "validation failed". If several cells are bad you get all of
them, not the first.

### Re-importing: update instead of duplicate

Choose a **key column** and what to do when it matches an existing record:

- **Update** the matching record (the default — it is why you set a key at all)
- **Skip** it
- **Create** anyway

and, separately, what to do when a row matches **nothing**: create it, or skip it.

Without a key every import creates, so re-importing a corrected file doubles everything. With one,
a weekly refresh of the same spreadsheet does what you expect.

The key can be the record title or any text, number, email, URL or id field. It cannot be a select,
a date or a checkbox — the wizard says so rather than matching badly. **A duplicate key in the
existing data is reported per row** rather than picking one of the matches silently.

## Field-type mapping

| Source type | StoryOS type | Notes |
|---|---|---|
| Text (one-line) | Text | |
| Rich Text | Rich text | the export is plain text, so formatting does not survive the round trip |
| Number | Number | thousands spaces and `,` decimals normalized |
| Date / Date range | Date | ranges lose the end date in v1 |
| Single-select / Workflow state | Select | options created from distinct values, labels preserved |
| Multi-select | Multi-select | |
| Checkbox | Checkbox | true/yes/1 |
| URL / Email | URL / Email | |
| Relation | Relation (match by title) | relation must exist in StoryOS first |
| People | Person | invite the people first — a cell only matches a member who already exists |

## Known non-migrations

Comments, files and automation rules do not come across. Rich-text formatting is lost in the
export rather than the import — a CSV cell is plain text by the time StoryOS sees it.

## Worked example (JCM)

1. Install the **Client Work** pack → Clients/Contacts/Projects/Tasks with relations wired.
   (Optional now — an import can create the relations itself — but starting from a pack still
   saves choosing every field type by hand.)
2. Export your four source databases to CSV.
3. Import `clients.csv` into Clients (Name → title, Status → existing select…).
4. Import `projects.csv` into Projects; map the `Client` column to the Client relation.
5. Import `tasks.csv` into Tasks; map `Project` to the Project relation, `State` to the
   existing State select (labels must match — rename options first if they differ).
6. Spot-check counts against the source, then invite the team.
