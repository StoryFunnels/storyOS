---
title: Databases & fields
description: Databases are user-defined types; fields are typed columns. Schema changes are runtime API calls, not migrations.
sidebar:
  order: 1
---

A **database** is a user-defined type — *Tasks*, *Clients*, *Articles*. It owns fields, records,
and views, and belongs to exactly one [space](/getting-started/concepts/). Every database has one
built-in **title** field (required, undeletable) plus system fields. Creating or changing a
database is a runtime API call, not a migration — **schema is data**.

## Field types

Each field has a stable `api_name` (used by the API and MCP), a display name, and type-specific
config.

| Type | Notes |
|---|---|
| `title` | Built-in, one per database; promoted to a real column for fast search and pickers. |
| `text` | Single- or multi-line (`{multiline}`). |
| `number` | Precision + format (`plain` / `percent` / `currency`). |
| `select` / `multi_select` | Options are first-class rows with stable IDs (see below). |
| `workflow` | A single-select-like canonical status — see below. **At most one per database.** |
| `date` | Optionally includes a time (`{include_time}`). |
| `checkbox` | Boolean. |
| `user` | A person; single or multi. |
| `url`, `email` | Validated text. |
| `relation` | A link to another database — see [relations](/concepts/relations/). |
| `lookup`, `rollup` | Derived from a relation — see [lookups & rollups](/concepts/lookups-and-rollups/). |
| `formula` | Computed from other fields — see [formulas](/concepts/formulas/). |
| `ai` | AI field: fills a value from a prompt; details coming. |
| `button` | Runs actions on click — see [automations & buttons](/concepts/automations/). |
| `created_at`, `updated_at`, `created_by` | System, read-only. Filterable and sortable like any other field, with the operators each type supports. |

### A system field's reduced `⋯` menu

`created_at` and `updated_at` get their own `⋯` on hover, same as every other column — but a
reduced one: **Filter by this field, Sort by this field, Hide field**. No Edit field, Change type,
or Delete field, because a system field is read-only and its position is fixed; there is nothing
those three would do. There's also no drag handle — a system column's position can't be reordered,
matching what the server has always enforced.

## The record page

A record opens as one **main column** and a fixed **side panel**.

- **Main column**, top to bottom: the title, a status strip (workflow status, assignee, due date and
  who's watching), the fields in labelled groups — **Details**, **Links**, **Computed** and **System**
  — then the **Description**, any embedded collections (sub-items and the like), and **Attachments**.
- **An empty strip shows Assignee and Due date, and hides the rest.** On a new record the status
  strip still draws a person field and a date field while they are empty, as chips you click to
  set, so assigning and dating a record takes one click each. Any other empty strip property
  (a select, a number, a relation) is left out and comes back through **+ Add property** at the end
  of the strip. A person or date field that someone hid on the record stays hidden.
- **Attachments appear only when they have something to show** — the database has an attachment
  field, or this record already has files. Existing files are never hidden.
- **Empty collections hide by default.** A collection on a record (many-to-many, or the many side of a
  one-to-many) is hidden while it has nothing in it; single references and ordinary fields keep
  showing. A field's own menu overrides this either way: **Hide when empty** or **Always show (even
  empty)**, and the menu shows the setting actually in force.
- **A related row shows its state, and the state is edited on that record.** In an embedded
  collection each row reads number, state glyph, title, then its chosen columns. The state glyph
  is the one a [list](/concepts/views/#state-glyphs-percent-chips-and-loading-in-lists-and-boards)
  draws, taken from the related database's workflow field or its first select with state
  categories. That field is not a column in the row and has no inline control: open the related
  record to change it. A collection of more than 50 rows shows its first 50 with a **Show all** link, and **Show
  less** folds it back. Changing a sort or filter keeps the rows on screen until the new first
  page arrives, and changing only the colouring repaints the rows without reloading them.
- **An embedded collection's filter is yours.** Filtering, sorting, colouring or choosing columns on a
  collection like Sub-items is a **personal** setting: it applies to you only, in every record of that
  database, and a **Personal · Reset** badge appears beside the collection while it's active. Reset
  drops the whole override and returns you to the shared default the field is configured with.
  Nobody else's view of the collection changes.
- **Comments show where they came from.** Each comment carries the same source badge the activity
  feed uses, so a comment an agent posted doesn't read as a person's. A comment from before sources
  were recorded shows the "source not recorded" badge rather than reading as human.
- **The side panel** (about 344px, hidden on a narrow window) has three tabs: **Activity**,
  **Comments** and **About**. About holds the **Watchers** list, **Mentioned in**, and a **Details**
  block — the database, space, record number, created and updated times, and your access.
- **Watching is a button now.** A **Watch** toggle in the record header (and in the About tab) follows
  the record: you're notified when it changes. See [mentions and
  notifications](/concepts/mentions-and-notifications/#watching-a-record-for-changes).
- **One list of fields, not zones.** The old split into a top strip, a sidebar and a body no longer
  shows; fields are one grouped area (the stored arrangement is kept, just not shown).
- The app calls an item by its database's own noun — a row in *Tasks* is a **task** — and falls back
  to "item". These docs say "record" for all of them.


## The row under a record's title

A record shows a row of field chips directly under its title — the most-read space on the record
screen. You choose which fields go there from the record itself, with **Top row**, which sits with
the other field controls ("New field", "N hidden") rather than in a separate place.

- **It's per database.** Pick a field once and every record in that database shows it in that
  row — not just the record you were on, and not just for you. An Article might pin its publish
  date; a Lead, its value.
- **Add or remove any field** from the Top row menu. Clearing every field returns the row to its
  automatic default.
- **A database nobody has configured looks exactly as it did before** — nothing is reshuffled
  when this ships, and a database only changes when someone picks a field.

## Preventing duplicate values

A `text` or `number` field can be marked **unique** — a second record can't save with a value
that duplicates an existing one in that field. Turning it on scans existing rows first and refuses
with the conflicts named, rather than silently letting existing duplicates through unnoticed.
**Multiple empty values are always allowed**, regardless of the setting — uniqueness only compares
values that are actually present. By default, comparison also **folds case and trims whitespace**
first, so `"SKU-1"` and `" sku-1 "` count as the same value; this normalization can be turned off.

**Enforced everywhere a value can be written** — a manual edit, a CSV import, a raw API call, and
an MCP/agent write are all rejected the same way, naming the record that already holds the value.
It's backed by a real database-level unique index underneath the app's own check, so two
concurrent writes can't both slip through a race the app-level check alone would miss. Turning the
setting back off keeps existing data exactly as it is; it only removes the constraint going
forward.

**Setting it is API/MCP-only today** — `update_field` takes `unique` and `unique_normalize` on an
existing field; there's no toggle in the web field editor yet.

## Select options are first-class

Options for `select` / `multi_select` / `workflow` fields are **real rows with stable IDs**, never
inline strings. Records store option **ids**, which means:

- Renaming an option is instant and O(1) — every record updates at once.
- Kanban column order is just option order, and so is sort order: **one position per option** drives
  the board's Field order, every sort by that field and every list of options. Positions are dense
  (0 to n-1). Reorder them in **Edit field**, or over the API with
  `POST /workspaces/{ws}/databases/{db}/fields/{field}/options/reorder` and
  `{ "order": [optionId, ...] }` (MCP: `reorder_options`). The list must name **every** option exactly
  once: a partial, duplicate or foreign id list is a `422` and nothing is written. It needs Creator
  access on the database.
- Deleting an option is an explicit, counted operation (with an optional "reassign to option X").

**An option can carry an icon** (from a curated icon set, not a free-typed emoji) in addition to
its colour, and the colour palette is not limited to the classic handful — pick whichever reads
right for that value.

## The Workflow field: one canonical status

A **Workflow** field is a `select` in every respect — same coloured options, same storage — with
one rule enforced by the server: **a database may have at most one.** Trying to add a second is
refused, naming the existing one, rather than letting two "status" columns drift against each
other. Reach for a plain `select` for any other list of choices; reach for Workflow specifically
for the one field a view, an automation, or an agent should treat as *the* state of a record.

### What a new Workflow field starts with

Add a Workflow field without listing any options (in the add-field dialog, over the API, or with the
MCP `add_field` tool) and it is created with three: **To do**, **In progress** and **Done**, coloured
gray, blue and green, in the state categories *unstarted*, *started* and *completed*.

- **Options you give are used exactly as given.** Nothing is added to your list, and an empty list
  counts as giving none.
- **A plain `select` field still starts empty.** The three defaults apply to the Workflow type only.
- **Workflow fields that already exist are not changed.** The defaults apply when a field is created.

### Finding the status columns you already have

Workspaces that predate the Workflow field usually have a plain select called "Status" in several
databases. There is no per-database hunt: **scan the whole workspace** and the answer comes back per
database, only for databases **you can read** (the others are simply absent):

- **already has a workflow field** (nothing to do),
- **has a candidate**, with how confident the match is and why: *high* when the name ("Status",
  "Stage", "Phase"...) and the options (To do, In progress, Done...) agree; *medium* when only the
  options look like a lifecycle; *low* when only the name does (a red-amber-green column called
  "Status" is the usual false friend, and it says so),
- **ambiguous**: more than one select qualifies, and since a database holds only one workflow field,
  a person chooses,
- or **nothing** looks like a lifecycle.

Converting is a separate step on the ones you pick. It **is a dry run by default**: it reports what
would convert and changes nothing until you ask for the real conversion. It uses the same conversion
as editing the field by hand, so option colours, option ids and every record's value are kept, and
each database succeeds or fails on its own (you need creator access on each). Through MCP these are
`find_workflow_candidates` and `nominate_workflows`; over the API, `GET` and `POST`
`/api/v1/workspaces/{ws}/workflow-nomination`.

## Converting a person field into a Members relation

A `user` field stores a bare user id. An admin can convert one into a real **relation to the Members
database**, so the person is a record you can link, filter and see from the person's side ("what is
assigned to this person"). It is **guided and reversible**:

- **Dry run first.** The default call changes nothing and reports how many records will link, which
  values cannot be resolved (a user id with no Members row), the field it would create, and, for every
  guest, whether they would see anything new.
- **Nothing is dropped.** Applying keeps the original field (renamed "Assignee (user)", same `api_name`,
  so saved views and automations keep working on it until you repoint them), creates the relation under
  the original name, and leaves anything it could not resolve on the retained field. List those records with
  *relation is empty* AND *retained field is not empty*.
- **A hidden paired field on Members.** Like every relation it has an inverse, created hidden so it does not
  reshuffle everyone's Members screen. A second converted field from the same database gets its own.
- **Permission-neutral, and checked.** After the change, each guest who cannot read Members is probed through
  the real read paths; if anything about Members shows up, the conversion is rolled back and names the guest.
  A guest who cannot read Members sees no chip at all.
- **Reversible.** The reverse writes the values back from the relation, restores the name, and removes the
  relation and its Members-side field. A Members row with no user id has its name parked in a text field.
  Lookups or rollups built on the relation are listed first and need `confirm_dependents`.

Admin only; over the API it is `POST .../fields/{field}/convert-to-members-relation` and
`.../convert-to-user` (both `dry_run` by default), over MCP `convert_user_field_to_members_relation` and
`convert_members_relation_to_user_field`.

## The title field: free text or computed

Every database's built-in title field starts as **free text** — you type it, like any other text
field. You can switch it to **Computed**: a template expression, written in the same editor a
formula field uses, that's compiled and materialized into the title on every create and update.
Once computed, the title is **read-only** — direct writes to it are ignored, the same way a
formula field ignores a direct write.

The template can reference the record's own fields, and — through a lookup — a related record's
fields too, so a title can read "Acme — Website Refresh" pulling the client's name across a
relation. It recomputes automatically as the fields it depends on change.

## Default values

A few field types can pre-fill a new record instead of starting empty, each in the shape that
actually stays true over time:

- **Checkbox** — "Checked by default on new records." Two states, so a literal default is the
  whole story.
- **Date** — "Default new records to today" is a flag, not a stored date. A literal default date
  would be correct for about a day and silently wrong after that; resolving "today" at the moment
  of insert is the only default that stays accurate.
- **Select / Workflow** — a **Default option** picker in the field's Edit dialog, with an explicit
  **None** to clear a default rather than merely leaving it blank. This one is **edit-time only** —
  a field you're still in the middle of creating has no default-option control yet, because its
  options are still local drafts without ids to point a default at. Configure the options first,
  save the field, then set the default from Edit.

  **A workflow field with no default starts at its first state.** A record created without a value
  for a Workflow (status) field gets the field's configured default, or else its **first** option in
  the field's own order, so a new record is on a board column and in a queue from the moment it
  exists. That holds on every way of creating a record: the app, REST, MCP, forms, CSV import and
  automations. The rules:
  - **A plain select is not filled.** An empty Priority or Type is a legitimate answer; an empty
    State is not.
  - **Passing a value is respected, including an explicit empty one.** Leaving the field out of the
    request is what triggers the default; sending the field as `null` keeps it empty. In a batch
    each record decides for itself.
  - **Existing records are not changed**, and neither is a record you later edit. Changing the
    default afterwards doesn't touch records that were already empty.
  - A workflow field with no options has nothing to default to, and the record is still created.

## Field lifecycle

- **Rename** — the `display_name` changes freely; the `api_name` is a stable slug (auto-generated,
  admin-editable with a warning) so integrations don't break.
- **Delete** — soft delete; orphaned values are ignored by reads and lazily cleaned up, so the
  action never blocks.
- **Change type** — a small compatibility matrix converts in place, and the same list drives the
  app's dialog and the API. A text field can become a number, date, rich text, **select**,
  **multi-select** or **workflow**; select, multi-select and workflow convert among themselves and
  to text; rich text, number, checkbox and date convert to text; URL and email convert to text or to
  each other. A person field has its own [Members conversion](#converting-a-person-field-into-a-members-relation),
  and an attachment field can't be converted in or out. Every conversion has a **dry run**
  ("Check impact") that reports what would happen and writes nothing. Everything else is an explicit
  "delete & create new".

### Turning a text field into choices

After an import or a CSV, a text column is often really a list of statuses or categories.
Converting it to **select**, **multi-select** or **workflow** turns the values into options:

- **One option per distinct value.** Values are trimmed, so `" Todo"` and `"Todo"` are the same
  option, but the comparison is case-sensitive, so `Todo` and `todo` stay two. Each record's value
  becomes that option. Empty and whitespace-only values stay empty.
- **A multi-select takes the whole value as one option.** There is no splitting on commas.
- **Options come out in the order they first appear** reading the table, with positions numbered from
  the first, and coloured from the palette in that order. Reorder them afterwards in Edit field; see
  [sorting by a choice field](/concepts/views/#sorting-by-a-choice-field).
- **More than 200 distinct values is refused**, in the dry run and in the real conversion, with a
  message that names the count: that many values is free text or an ID column, not a list of choices.
  Exactly 200 is allowed.
- **The dry run lists the options it would create**, with how many records each covers and how many
  records are empty. In the app, the Change type dialog shows that list before you confirm.
- **A workflow target keeps the one-workflow-per-database rule**: if the database already has a
  workflow field, converting to workflow is refused with a `409`.
- Over MCP this is `change_field_type`. It needs the same access as any other field change.

For the full canonical model and JSONB storage mechanics, see the
[data model reference](/concepts/data-model/).
