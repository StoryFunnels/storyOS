---
title: MCP tools
description: The read, write, and schema-building tools the StoryOS MCP server exposes to AI agents.
sidebar:
  order: 2
---

The MCP server exposes three families of tools: **read**, **write**, and **build/schema**. Agents
design the workspace, not just fill it. Always call `get_started` first.

## Read

| Tool | What it does |
|---|---|
| `get_started` | Orientation, a workspace map, and the filter cheat-sheet. Call first. |
| `list_workspaces` | Workspaces the token can access. |
| `list_databases` | Databases in a workspace. |
| `describe_database` | A database's schema — exact `api_name`s, types, options, relation targets. **Read before writing.** |
| `search` | Full-text record search — turn a name into a real id. |
| `query_records` | Filter / sort / paginate records with the structured filter AST. |
| `get_record` | One record in full, by uuid or public number. |
| `get_links` | Web-app URLs for a database, its saved views, and/or a batch of records — no round-trip per record. |

## Write

Each write returns the resulting record; each `422` is surfaced verbatim.

| Tool | What it does |
|---|---|
| `create_record` | Create a record; `values` by `api_name`, selects accept the **label**. |
| `update_record` | Merge-update (null clears); record by uuid or public number. |
| `delete_record` | Trash a record (restorable 30 days). |
| `link_records` | Link a record to targets through a relation field. |
| `add_comment` | Post a comment. |
| `run_button` | Press a button field, running its automation actions. |
| `duplicate_record` | Copy a record within the **same** database (unlike `copy_records`, a different one) — values, links, description, and its comment thread + attachments, all copied onto the new record. Owned one-to-many collections are NOT copied (a duplicated project doesn't clone its tasks). |
| `copy_records` | Copy one or more records into a **different** database (unlike `duplicate_record`, same database). Fields auto-match by name; one with a value and no destination match **blocks** the copy. Call with `dry_run: true` (the default) to see the mapping and any blocking fields, resolve a row with `skip` (drop it) or `override` (send it to a specific destination field instead of the auto-match — or resolve an ambiguous relation by naming which candidate to use), then call again with `dry_run: false`. `override` is MCP/API-only — the web dialog's mapping is still read-only. |

## Personal space

A view or space owned by the **calling identity**, invisible to everyone else including admins —
see [Personal space](/concepts/personal-space/) for what that guarantees.

| Tool | What it does |
|---|---|
| `get_or_create_personal_space` | My own personal space. Idempotent — lazily provisioned on first call, returns the same space every time after. |
| `create_personal_view` | A view over a **shared** database that only I can see (deleting a record through it still deletes it for everyone — it's a lens, not a private copy). Needs only read access, unlike `create_view`, and is never folder-placed. |

**`create_personal_view` accepts `form` as a type; the web dialog doesn't offer it.** The app's own
picker restricts to seven types for a reason stated in the UI (form and dashboard don't fit a
private-lens framing) — that's a client-side choice, not an API restriction, so a form-type
personal view is only reachable from here today.

## Build / schema

| Tool | What it does |
|---|---|
| `list_spaces` / `create_space` | List / create spaces. |
| `create_database` / `update_database` / `delete_database` | Create, rename/move, or delete a database (delete needs `confirm` = name). |
| `add_field` / `update_field` / `delete_field` / `change_field_type` | Manage fields; select options by label; convert a field's type (`dry_run` to preview). |
| `create_view` / `update_view` / `delete_view` | Manage views; accepts `group_by` / `card_fields` / date fields plus `filters` + `sorts`. |
| `create_relation` / `delete_relation` | Link two databases (one_to_many / many_to_many) — paired relation fields. |
| `reorder_fields` / `reorder_views` | Set field / view order by name. |

## Conveniences

- `query_records` / `get_record` return select values as **labels** (not option ids).
- `create_record` / `update_record` accept a plain **string** on a rich_text field (auto-wrapped to
  blocks) and select **labels**.
- `create_record` reports any **unset** template fields so the agent can fill them.
- `get_record` / `query_records` / `create_record` / `update_record` all include a `url` — a
  clickable web-app link for that record, e.g. `https://app.storyos.dev/w/{workspace_id}/d/{database_id}/r/{title-slug}-{number}`
  (falls back to the record's uuid when it has no public number yet). Use `get_links` for a
  database or view link, or to resolve a batch of record links in one call.
- **A `workflow` field (the canonical status column on almost every database) filters exactly like
  `select`** over MCP — `describe_database` returns its own `ops` array so you don't have to guess,
  and `query_records` / `count_records` accept either an option's label or its id, translating
  `eq`/`neq` to `has`/`has_none` for you. See the [operator × type
  matrix](/api/conventions/#operator--type-matrix) for the raw API's own shape, which wants the
  option **id** only — the label resolution above is an MCP-side convenience.

For the concepts these tools operate on, see [databases & fields](/concepts/databases-and-fields/),
[relations](/concepts/relations/), and [views](/concepts/views/).
