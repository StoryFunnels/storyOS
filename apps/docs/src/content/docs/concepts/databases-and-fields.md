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
| `date` | Optionally includes a time (`{include_time}`). |
| `checkbox` | Boolean. |
| `user` | A person; single or multi. |
| `url`, `email` | Validated text. |
| `relation` | A link to another database — see [relations](/concepts/relations/). |
| `lookup`, `rollup` | Derived from a relation — see [lookups & rollups](/concepts/lookups-and-rollups/). |
| `formula` | Computed from other fields — see [formulas](/concepts/formulas/). |
| `button` | Runs actions on click — see [automations & buttons](/concepts/automations/). |
| `created_at`, `updated_at`, `created_by` | System, read-only. |

## Select options are first-class

Options for `select` / `multi_select` fields are **real rows with stable IDs**, never inline
strings. Records store option **ids**, which means:

- Renaming an option is instant and O(1) — every record updates at once.
- Kanban column order is just option order.
- Deleting an option is an explicit, counted operation (with an optional "reassign to option X").

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
