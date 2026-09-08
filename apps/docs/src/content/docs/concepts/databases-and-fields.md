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
| `button` | Runs actions on click — see [automations & buttons](/concepts/automations/). |
| `created_at`, `updated_at`, `created_by` | System, read-only. Filterable and sortable like any other field, with the operators each type supports. |

### A system field's reduced `⋯` menu

`created_at` and `updated_at` get their own `⋯` on hover, same as every other column — but a
reduced one: **Filter by this field, Sort by this field, Hide field**. No Edit field, Change type,
or Delete field, because a system field is read-only and its position is fixed; there is nothing
those three would do. There's also no drag handle — a system column's position can't be reordered,
matching what the server has always enforced.

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
- Kanban column order is just option order.
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

## Field lifecycle

- **Rename** — the `display_name` changes freely; the `api_name` is a stable slug (auto-generated,
  admin-editable with a warning) so integrations don't break.
- **Delete** — soft delete; orphaned values are ignored by reads and lazily cleaned up, so the
  action never blocks.
- **Change type** — a small compatibility matrix converts in place (anything → text; text →
  number/date best-effort; select ↔ multi_select). The API returns a **dry-run count** of lossy
  conversions before applying. Everything else is an explicit "delete & create new".

For the full canonical model and JSONB storage mechanics, see the
[data model reference](/concepts/data-model/).
