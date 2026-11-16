# Changelog

## 0.1.2

The first release since 0.1.1. The server also now reports its real package
version in `serverInfo.version` (it still said `0.1.0`).
Declares the MCP Registry name so the package can be listed.

### New tools

- **Agents and runs**: `get_agent_budget`, `get_agent_scope`,
  `get_agent_wake_sources`, `get_agent_wake_summary`, `list_agent_wakes`,
  `list_agent_catch_up`, `list_agent_write_gates`, `list_action_gates`,
  `rerun_run`, `list_runners`, `get_activity_event`, `get_credential`,
  `list_credential_actions`, `list_ai_connections`.
- **Records**: `count_records_grouped`, `preview_formula` (dry-run a formula),
  `get_branch_name`, `restore_document_version`, `list_validation_rules`,
  `get_validation_rule_violations`, and record templates
  (`list_record_templates`, `create_record_template`,
  `update_record_template`, `delete_record_template`,
  `create_record_from_template`).
- **Workspace structure**: `reorder_options`, `create_space_group`,
  `update_space_group`, `delete_space_group`, `list_space_groups`,
  `convert_user_field_to_members_relation`,
  `convert_members_relation_to_user_field`, `find_workflow_candidates`,
  `nominate_workflows`.
- **Personal state and skills**: `get_personal_collection_filter`,
  `set_personal_collection_filter`, `get_pinned_tabs`, `set_pinned_tabs`,
  `get_dismissed_hints`, `set_dismissed_hints`, `import_skill`.

### Changed

- `tools/list` shows only the tools the connected person's role can use.
- A lighter tool listing for clients that cap the size of tool definitions;
  the long grammars moved into `get_started` sections.
- Tool descriptions were rewritten to state facts, and six descriptions that
  did not match behaviour were corrected.
- Filters accept `category_is` / `category_is_not` on workflow and select
  fields; sorting by a select, workflow or multi-select field follows option
  order.
- An automation writes a select, workflow or multi-select field by its label,
  and an unknown label fails the run naming the valid ones.
- Packs: install into an existing space, packs that build on other packs, and
  a reuse preview that lists candidate databases.
- `get_my_work` gains `waiting` and `assigned_by_me` and drops
  finished rows.
- `delete_record` / `delete_records` report honestly when a delete is held
  for approval.

### Fixed

- `update_view` keeps form configuration it does not itself edit.
- `create_skill` and `import_skill` leave visibility to the server.
- The hosted HTTP endpoint answers 413 for request bodies over 4 MiB.
- Input-validation and outbound-request hardening across several tools.
