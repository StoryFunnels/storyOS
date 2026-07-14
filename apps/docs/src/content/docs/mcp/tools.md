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

For the concepts these tools operate on, see [databases & fields](/concepts/databases-and-fields/),
[relations](/concepts/relations/), and [views](/concepts/views/).
