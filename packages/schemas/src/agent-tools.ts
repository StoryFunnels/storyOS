import { z } from 'zod';

/**
 * #1180 - what a manager can set on an agent that runs on a Runner: the MCP tools it is offered and its model.
 *
 * TOOLS (the agent record's `tools` text, comma-separated names). The DEFAULT, with nothing saved, is the 8-tool ESSENTIALS preset
 * (AGENT_RUN_PRESET_TOOLS: read the record and its comments, find and count records, describe a database, change a field, comment,
 * create a record; ~12k input tokens a run). A saved list names EXTRA tools, ADDED to the essentials (which are always offered, so
 * get_record and add_comment can never be missing). The one-word value `all` (AGENT_TOOLS_ALL) is the explicit opt-in to EVERY tool the
 * credential's role allows (~97k a run on the measured wake). Each offered tool is billed on every request of every run, so this is a
 * COST control, never a permission: the credential's role and scope still decide at call time.
 *
 * MODEL: the agent's own `model` (empty = use the workspace default), then the workspace's `default_agent_model` (empty = pass nothing,
 * the customer's own CLI default). Both validated by the one rule below, at write time.
 *
 * MCP_TOOL_NAMES is the name of every tool the StoryOS MCP server can register (the registry in packages/mcp/src/tools.ts).
 * It is listed here because the API validates an agent's `tools` setting at WRITE time and cannot import the MCP package; a
 * test in packages/mcp (agent-tools.test.ts) enumerates the LIVE registry and fails when this list and the registry differ,
 * so adding a tool means adding its name here (the test says so). This is the set a person may CHOOSE from. It is not a
 * permission list: what a run may actually call is still decided by its credential's scope and role, at call time.
 */
export const MCP_TOOL_NAMES: readonly string[] = [
  'add_comment',
  'add_field',
  'apply_template',
  'attach_file',
  'browse_pack_marketplace',
  'build_schema',
  'change_field_type',
  'convert_members_relation_to_user_field',
  'convert_user_field_to_members_relation',
  'copy_document_to_personal_space',
  'copy_records',
  'copy_view_to_personal_space',
  'count_records',
  'count_records_grouped',
  'create_agent_trigger',
  'create_automation',
  'create_database',
  'create_document',
  'create_folder',
  'create_personal_view',
  'create_portal_recipient',
  'create_record',
  'create_records',
  'create_relation',
  'create_skill',
  'create_source',
  'create_space',
  'create_space_group',
  'create_space_view',
  'create_view',
  'delegate_to_agent',
  'delete_attachment',
  'delete_automation',
  'delete_comment',
  'delete_database',
  'delete_document',
  'delete_field',
  'delete_folder',
  'delete_record',
  'delete_records',
  'delete_relation',
  'delete_skill',
  'delete_source',
  'delete_space',
  'delete_space_group',
  'delete_space_view',
  'delete_view',
  'delete_webhook',
  'describe_database',
  'discover_source_fields',
  'duplicate_database',
  'duplicate_record',
  'duplicate_view',
  'enqueue_bulk_record_job',
  'export_pack',
  'export_skill',
  'find_select_drift',
  'find_workflow_candidates',
  'fix_select_drift',
  'get_activity_event',
  'get_agent_budget',
  'get_agent_scope',
  'get_agent_wake_summary',
  'get_agents',
  'get_automation',
  'get_automation_last_payload',
  'get_bulk_record_job',
  'get_credential',
  'get_dismissed_hints',
  'get_document',
  'get_field_usage',
  'get_history',
  'get_links',
  'get_my_work',
  'get_or_create_personal_space',
  'get_personal_collection_filter',
  'get_personal_filter',
  'get_pinned_tabs',
  'get_record',
  'get_record_description',
  'get_relation',
  'get_run',
  'get_run_quota',
  'get_runs',
  'get_skill',
  'get_staged_action',
  'get_started',
  'get_unread_count',
  'get_validation_rule_violations',
  'get_view',
  'get_workspace',
  'import_skill',
  'install_pack',
  'link_records',
  'list_action_gates',
  'list_agent_activity',
  'list_agent_catch_up',
  'list_agent_wakes',
  'list_agent_write_gates',
  'list_ai_connections',
  'list_approvals',
  'list_attachments',
  'list_audit_log',
  'list_automations',
  'list_backlinks',
  'list_comments',
  'list_connection_providers',
  'list_connections',
  'list_credential_actions',
  'list_database_comments',
  'list_databases',
  'list_databases_trash',
  'list_documents',
  'list_folders',
  'list_grants',
  'list_hierarchy_activity',
  'list_icon_set',
  'list_installed_packs',
  'list_invites',
  'list_linked_records',
  'list_members',
  'list_notifications',
  'list_pack_submissions',
  'list_packs',
  'list_personal_views',
  'list_portal_activity',
  'list_portal_recipients',
  'list_records',
  'list_relations',
  'list_runners',
  'list_skill_templates',
  'list_skills',
  'list_source_providers',
  'list_source_runs',
  'list_sources',
  'list_space_groups',
  'list_space_views',
  'list_spaces',
  'list_spaces_trash',
  'list_templates',
  'list_trash',
  'list_validation_rules',
  'list_views_trash',
  'list_watchers',
  'list_webhook_deliveries',
  'list_webhooks',
  'list_workspaces',
  'list_youtube_channels',
  'mark_notifications',
  'move_document_to_space',
  'move_record',
  'nominate_workflows',
  'propose_schema',
  'publish_view',
  'query_records',
  'remove_sample_data',
  'reorder_fields',
  'reorder_options',
  'reorder_views',
  'rerun_action',
  'rerun_run',
  'restore_database',
  'restore_document_version',
  'restore_records',
  'restore_space',
  'restore_version',
  'restore_view',
  'revoke_portal_recipient',
  'rotate_portal_recipient',
  'run_agent',
  'run_auto_link',
  'run_button',
  'run_skill',
  'search',
  'set_auto_link',
  'set_default_view',
  'set_dismissed_hints',
  'set_favorite',
  'set_personal_collection_filter',
  'set_personal_filter',
  'set_pinned_tabs',
  'setup_agents',
  'share_view',
  'sync_source',
  'test_automation',
  'undo_batch_update',
  'uninstall_pack',
  'unlink_records',
  'unshare_view',
  'update_automation',
  'update_comment',
  'update_database',
  'update_document',
  'update_field',
  'update_folder',
  'update_record',
  'update_record_description',
  'update_records',
  'update_skill',
  'update_source',
  'update_space',
  'update_space_group',
  'update_space_view',
  'update_view',
  'update_webhook',
  'update_workspace',
  'upsert_record',
  'watch_record',
];

/** The model string is passed to the tool's `--model` flag as one argv element, never through a shell; it is still kept to a safe alphabet. */
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
export const AGENT_MODEL_MAX = 100;
export const agentModelSchema = z
  .string()
  .max(AGENT_MODEL_MAX)
  .regex(AGENT_MODEL_PATTERN, 'must be a model name: letters, digits and . _ : / [ ] - only, starting with a letter or digit (no spaces, no leading dash)');

/** The value of `tools` that opts in to every tool the credential's role allows (instead of the essentials plus chosen extras). */
export const AGENT_TOOLS_ALL = 'all';

/** The ESSENTIALS: what an agent with no saved Tools is offered (packages/mcp tool-profiles.ts AGENT_RUN_BASE_TOOLS; a test keeps the two equal). */
export const AGENT_RUN_PRESET_TOOLS: readonly string[] = [
  'get_record',
  'list_comments',
  'query_records',
  'count_records',
  'describe_database',
  'update_record',
  'add_comment',
  'create_record',
];

/** Splits the stored `tools` text (commas, spaces or new lines) into distinct names, in the order written. Does not validate. */
export function parseAgentTools(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

export type AgentSettingsProblem = { field: 'tools' | 'model'; message: string };

/**
 * The one validator for the two settings (the API write path; the UI can call it too). A null or empty value is "not set" and is
 * fine: it means the default tool set and the customer's own default model.
 */
export function validateAgentSettings(values: { tools?: unknown; model?: unknown }): AgentSettingsProblem[] {
  const problems: AgentSettingsProblem[] = [];
  if (values.tools !== undefined && values.tools !== null && values.tools !== '') {
    if (typeof values.tools !== 'string') {
      problems.push({ field: 'tools', message: '"tools" must be text: tool names separated by commas.' });
    } else {
      const unknown = parseAgentTools(values.tools).filter((t) => t !== AGENT_TOOLS_ALL && !MCP_TOOL_NAMES.includes(t));
      if (unknown.length > 0) {
        problems.push({
          field: 'tools',
          message: `Unknown tool name${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => JSON.stringify(u.slice(0, 60))).join(', ')}. Valid names: ${AGENT_TOOLS_ALL}, ${MCP_TOOL_NAMES.join(', ')}.`,
        });
      }
    }
  }
  if (values.model !== undefined && values.model !== null && values.model !== '') {
    const m = values.model;
    if (typeof m !== 'string') problems.push({ field: 'model', message: '"model" must be text.' });
    else if (m.length > AGENT_MODEL_MAX || !AGENT_MODEL_PATTERN.test(m)) {
      problems.push({
        field: 'model',
        message: `"model" must be a model name: up to ${AGENT_MODEL_MAX} characters, starting with a letter or digit, using only letters, digits and . _ : / [ ] - (no spaces, no leading dash). Leave it empty to use your tool's own default.`,
      });
    }
  }
  return problems;
}
