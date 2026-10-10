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
| `list_agent_activity` | Everything one configured Agent wrote in a date range — writes made through an ordinary token never carry agent attribution, so only agent-scoped ones show up here. |
| `list_database_comments` | Every comment and `#record` reference across a whole database, newest first — see [mentions and notifications](/concepts/mentions-and-notifications/#a-feed-across-many-records-comments-and-references-over-time). |
| `list_hierarchy_activity` | The same feed, rooted at one record and walked down a chain of relation fields (e.g. Epic → Story → Task), up to 5 levels — permission-checked at every level. |

## Write

Each write returns the resulting record; each `422` is surfaced verbatim.

| Tool | What it does |
|---|---|
| `create_record` | Create a record; `values` by `api_name`, selects accept the **label**. |
| `upsert_record` | Match-or-create on a [unique field](/concepts/databases-and-fields/#preventing-duplicate-values) — a matching value updates that record, no match creates one. Returns `{ record, created }` so a caller can tell which branch it took; idempotent on repeat. An [automation rule's own "Create a record" action](/concepts/automations/#creating-or-upserting-a-record) can do the same thing via `upsert`. |
| `update_record` | Merge-update (null clears); record by uuid or public number. |
| `delete_record` | Trash a record (restorable 30 days). |
| `update_records` / `delete_records` | Apply one patch to, or trash, up to 200 records in one call; partial failures come back per record. An update returns a `restorable` list. |
| `undo_batch_update` | Revert an `update_records` call by passing its `restorable` list back verbatim. |
| `enqueue_bulk_record_job` / `get_bulk_record_job` | For selections above one call's limit (up to 50,000): a durable, resumable background update/delete job, then poll its progress. See [bulk operations](/api/conventions/#bulk-operations). |
| `link_records` | Link a record to targets through a relation field. |
| `add_comment` | Post a comment. |
| `run_button` | Press a button field, running its automation actions. |
| `duplicate_record` | Copy a record within the **same** database (unlike `copy_records`, a different one) — values, links, description, and its comment thread + attachments, all copied onto the new record. Owned one-to-many collections are NOT copied (a duplicated project doesn't clone its tasks). |
| `copy_records` | Copy one or more records into a **different** database (unlike `duplicate_record`, same database). Fields auto-match by name; one with a value and no destination match **blocks** the copy. Call with `dry_run: true` (the default) to see the mapping and any blocking fields, resolve a row with `skip` (drop it) or `override` (send it to a specific destination field instead of the auto-match — or resolve an ambiguous relation by naming which candidate to use), then call again with `dry_run: false`. `override` is MCP/API-only — the web dialog's mapping is still read-only. |

## Trash & restore

Databases, spaces, and views are trashed and restorable the same way a record is — nothing here
erases outright.

| Tool | What it does |
|---|---|
| `list_trash` / `restore_records` | A database's deleted records (30-day retention) and bringing one back. |
| `list_views_trash` / `restore_view` | A database's deleted views. |
| `list_spaces_trash` / `restore_space` | Workspace-wide deleted spaces (**admin only**) — restoring one brings back every database it held automatically. |
| `list_databases_trash` / `restore_database` | Workspace-wide deleted databases (**admin only**). |

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

## More read tools

| Tool | What it does |
|---|---|
| `get_workspace` | One workspace by name, slug or id, with its full metadata and settings. |
| `list_members` / `list_invites` | Who is in the workspace and their role (check **before** writing a `user` field — a non-member is rejected); invitations not yet accepted. Read-only. |
| `list_relations` / `get_relation` | The whole relation graph in one call (read before structural work); one relation's sides, cardinality, auto-link rules and the comparable fields `set_auto_link` accepts. |
| `list_linked_records` | The full link set of one relation field on a record, as records you can act on. (Not `get_links`, which builds web URLs.) |
| `list_records` | Records in the hand-arranged (drag) order a person sees — the one thing `query_records` can't express. |
| `count_records_grouped` | Count, or sum/average/min/max a numeric field, **per group** of another field, computed in the database — for "how many of each status" and board column counts. |
| `get_field_usage` | What depends on a field before you delete it: records with a value, and the views, automations and formulas that reference it. Call before `delete_field`. |
| `get_view` | One view by id, whether it belongs to a database or a space. |
| `list_space_views` | Views that belong to a **space** (dashboards over several databases), which `describe_database` never shows. |
| `list_sources` / `list_youtube_channels` | The scheduled syncs feeding a database (provider, schedule, status, last sync); the channels a connected Google account owns, needed to configure a YouTube source. |
| `get_record_description` | A record's rich-text description (the block editor under its title) — not a custom field called "description". |
| `list_comments` | A record's comment thread, newest first, each with its id, author, and `source`. |
| `update_comment` / `delete_comment` | Edit or delete a comment **you** wrote (admins may delete any; editing someone else's is refused). Deleting is final — a comment has no browsable trash. |
| `list_action_gates` / `list_approvals` | Workspace-declared approval gates and the held items. Read-only by design — approving is a person's act, in the app Inbox. |

## Documents and folders

A **document** is a standalone page in a space, belonging to no record — use it for a write-up or
plan instead of cramming prose into a record or inventing a database for one page.

| Tool | What it does |
|---|---|
| `list_documents` / `get_document` | Titles and ids in a space; one document as Markdown, with its `version`. |
| `create_document` | Write a page in a space (`content` is Markdown). |
| `update_document` | Change title, icon, folder or body. `content` **replaces** the whole body, so read it first; pass the `version` you read to be told about a conflicting edit rather than overwrite it. |
| `delete_document` | Permanent — a document has no browsable trash. |
| `list_folders` / `create_folder` / `update_folder` / `delete_folder` | Sidebar folders in a space. List first so you don't make a near-duplicate. Deleting a folder deletes nothing in it — contents fall back to the space root. |
| `update_record_description` | Overwrite a record's rich-text description (Markdown). |
| `restore_document_version` / `restore_version` | Roll a record's **description**, or its **field values**, back to a captured version — see [record history](/concepts/record-history/). Both are recorded and undoable. |

## Building and reshaping a workspace

| Tool | What it does |
|---|---|
| `propose_schema` → `build_schema` | Turn a plain-language goal into a plan of databases, fields, relations and states (each create-new or reuse-existing) — creates nothing; then build the approved plan in one call. |
| `list_templates` / `apply_template` | Single-database or small-space starter templates. They seed sample rows; `remove_sample_data` deletes exactly those and nothing a person added. |
| `list_packs` / `install_pack` / `list_installed_packs` / `uninstall_pack` | The built-in Business Pack gallery; install by slug (idempotent; `preview` shows what it would create without creating it); what's installed, with the **install id** uninstall needs. Check installed packs first — installing twice makes a second copy. |
| `browse_pack_marketplace` / `list_pack_submissions` / `export_pack` | Community packs; your submissions' review status (read-only); turn part of this workspace into an installable pack manifest. |
| `duplicate_database` / `duplicate_view` | Copy a database's schema, views and self-relations into a new independent database; copy a view with its filters, sorts and layout. |
| `set_auto_link` / `run_auto_link` | Teach a relation to link itself from matching field pairs; apply the rules to records that already exist (use after an import). |
| `find_select_drift` / `fix_select_drift` | Find records that look linked through a matching select label but carry no actual link; link them in one call (show the list to a person first). |
| `unlink_records` / `move_record` | Remove specific links without touching the relation; reposition a record in manual order (`before` or `after`). |
| `create_records` | Create up to 100 records in one atomic call — all succeed or none do. |
| `set_default_view` / `set_favorite` | Which view people land on; star a record or database for the calling identity. |
| `list_icon_set` | The curated icon names usable as `icon` on databases and spaces. |

### Space-level views and groups

| Tool | What it does |
|---|---|
| `create_space_view` / `update_space_view` / `delete_space_view` | A space-level **dashboard** that reads from several databases (`update` can also move a database dashboard into a space). Deleting a view never deletes the records it showed. |
| `list_space_groups` / `create_space_group` / `update_space_group` / `delete_space_group` | Presentational sidebar groups above spaces. Deleting a group leaves its spaces ungrouped. |
| `delete_space` | Soft delete of a space and everything in it — restorable; see [trash and restore](#trash--restore). |

## Personal space and personal filters

Alongside the tools above: `list_personal_views` (every personal view you own, workspace-wide),
`copy_view_to_personal_space` / `copy_document_to_personal_space` (an independent fork, never synced
back), and `publish_view` / `move_document_to_space` (the one-way move out of Personal).
`get_personal_filter` / `set_personal_filter` read and set **your own** extra filter on a view — "the
team board, but just my rows"; invisible to teammates, and `clear: true` removes it. The
`get_personal_collection_filter` / `set_personal_collection_filter` pair does the same for a record page's embedded relation collection.

## Me: notifications and my work

| Tool | What it does |
|---|---|
| `get_my_work` | `assigned` (default), `created`, or `recent` records for the identity the token belongs to. |
| `list_notifications` / `get_unread_count` / `mark_notifications` | What's waiting for you (assignments, mentions, comments, state changes, approval requests); a single unread number; mark read or archive (`all: true` clears the inbox). |

## Agents, runs and automations

| Tool | What it does |
|---|---|
| `get_agents` / `setup_agents` | Whether the Agentic OS space exists (with a summary), and provisioning it (idempotent). |
| `run_agent` / `delegate_to_agent` | Run an agent by hand and get its Run back; hand one record to an agent, which posts its outcome back on the record as a comment linking to the Run. |
| `create_agent_trigger` | Fire an agent when a record reaches a given state; `human_gate: true` makes it stage its action for a person to approve. |
| `get_run` / `get_staged_action` / `rerun_action` / `get_run_quota` | One run in full (each action's attempts and artifacts); what a parked run is waiting to do (read-only — approving is human-only); retry one failed action with its original inputs; this month's run usage against your plan. |
| `test_automation` / `get_automation_last_payload` | Dry-run a rule against one record before trusting it (no side effects unless you pass an `action_index`); the latest payload a webhook-triggered rule received. |

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
