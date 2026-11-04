import { AGENT_RUN_PRESET_TOOLS, AGENT_TOOLS_ALL, MCP_TOOL_NAMES, parseAgentTools, validateAgentSettings } from '@storyos/schemas';
import { atLeast } from '@/lib/access';
import type { EffectiveRole } from '@/lib/access';

/**
 * Ticket #1180 (web) — what a manager can set on an agent that runs on a Runner: the tools it is offered and its model.
 * The API half is PR #1381; the contract is `packages/schemas/src/agent-tools.ts`, and every rule below mirrors it:
 *
 *  - `tools` is ONE text field of comma-separated MCP tool names. EMPTY = the 8 ESSENTIALS. A saved list = EXTRAS added to the
 *    essentials (the essentials are always offered, so they are shown ticked and fixed: the server cannot store a removed one).
 *    The one word `all` opts in to every tool the role allows; it is a value, never a tool name.
 *  - These are COST controls, never permissions: the credential's role and scope still decide at call time.
 *  - `model` is text; empty/null = follow the workspace's `default_agent_model`; that empty = pass nothing (the tool's own default).
 */

/** The 8 essentials, labelled as Dara's prototype (v60) names them; the MCP name is the tooltip. Order is the prototype's. */
export const ESSENTIAL_TOOLS: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'get_record', label: 'Read a record' },
  { name: 'list_comments', label: 'Read comments' },
  { name: 'query_records', label: 'Find records' },
  { name: 'count_records', label: 'Count records' },
  { name: 'describe_database', label: 'See a database’s fields' },
  { name: 'update_record', label: 'Change a record (any of its fields)' },
  { name: 'add_comment', label: 'Comment' },
  { name: 'create_record', label: 'Create a record' },
];

/**
 * The extras a person may add with one click. There is NO exported role map in `@storyos/schemas` (the role gate lives in
 * `packages/mcp/src/role-gates.generated.ts`, which the web may not import), so this list is chosen, not derived: it holds
 * only tools open to every member (a test reads the generated gate file and fails if one becomes admin-only) and it leaves
 * out every `delete_*` tool (deletion has its own approval policy, ticket #1178, and a checkbox here would look like a grant
 * of it) and everything that changes the workspace itself. What a given agent's role and scope really allow is still decided
 * by the server when a run starts, so a ticked extra its owner's role cannot use is simply not offered to the run.
 */
export const EXTRA_TOOLS: ReadonlyArray<{ name: string; label: string; why: string }> = [
  { name: 'link_records', label: 'Link records', why: 'Connect a record to others, e.g. a task to its client' },
  { name: 'unlink_records', label: 'Unlink records', why: 'Remove a connection between two records' },
  { name: 'search', label: 'Search everything', why: 'Look across all databases and documents' },
  { name: 'get_document', label: 'Read documents', why: 'Open a document for context' },
  { name: 'list_documents', label: 'List documents', why: 'See which documents a space holds' },
  { name: 'create_document', label: 'Write a document', why: 'Draft a new document' },
  { name: 'update_document', label: 'Edit a document', why: 'Change the text of a document' },
  { name: 'attach_file', label: 'Attach a file', why: 'Add a file to a record' },
  { name: 'list_attachments', label: 'See a record’s files', why: 'List the files attached to a record' },
  { name: 'list_linked_records', label: 'Follow links', why: 'Read the records linked to this one' },
  { name: 'get_history', label: 'Read a record’s history', why: 'See what changed on a record and when' },
  { name: 'create_records', label: 'Create several records', why: 'Add many records in one go' },
  { name: 'update_records', label: 'Change several records', why: 'Change many records in one go' },
  { name: 'upsert_record', label: 'Create or update a record', why: 'Match on a field, so a repeat run does not add a duplicate' },
  { name: 'duplicate_record', label: 'Copy a record', why: 'Make a copy of a record' },
  { name: 'list_databases', label: 'List databases', why: 'See which databases exist' },
  { name: 'list_members', label: 'See who is in the workspace', why: 'Names, so work can be assigned' },
];

const ESSENTIAL_NAMES = new Set<string>(AGENT_RUN_PRESET_TOOLS);
const EXTRA_NAMES = new Set(EXTRA_TOOLS.map((t) => t.name));
const REGISTRY = new Set<string>(MCP_TOOL_NAMES);

export interface ToolsView {
  /** The saved value is the opt-in `all`: every tool the role allows. */
  all: boolean;
  /** Names from the offered list that are saved (ticked). */
  ticked: ReadonlySet<string>;
  /**
   * Saved names the offered list does not carry, in saved order, each droppable: a real tool the page does not list here
   * (set through the API or a connected AI, e.g. `delete_record`) or a name the registry no longer has. Never dropped silently.
   */
  other: Array<{ name: string; known: boolean }>;
}

/** Reads the stored `tools` text for the screen. Anything the page does not offer is KEPT and shown, never discarded. */
export function toolsView(raw: unknown): ToolsView {
  const saved = parseAgentTools(raw);
  const all = saved.includes(AGENT_TOOLS_ALL);
  const names = saved.filter((n) => n !== AGENT_TOOLS_ALL && !ESSENTIAL_NAMES.has(n));
  return {
    all,
    ticked: new Set(names.filter((n) => EXTRA_NAMES.has(n))),
    other: names.filter((n) => !EXTRA_NAMES.has(n)).map((name) => ({ name, known: REGISTRY.has(name) })),
  };
}

/** The text to store: comma-separated, de-duplicated, in the order saved with new ones last. Empty is null: "not set" = the essentials. */
export function serializeTools(names: readonly string[], all = false): string | null {
  const out = [...new Set(names.filter((n) => n && n !== AGENT_TOOLS_ALL && !ESSENTIAL_NAMES.has(n)))];
  if (all) out.unshift(AGENT_TOOLS_ALL);
  return out.length ? out.join(',') : null;
}

/** One click on an extra (or on Remove): the new stored text. Every other saved name, including ones this page does not list, is kept. */
export function toggleTool(raw: unknown, name: string, on: boolean): string | null {
  const saved = parseAgentTools(raw);
  const all = saved.includes(AGENT_TOOLS_ALL);
  const rest = saved.filter((n) => n !== AGENT_TOOLS_ALL && n !== name);
  return serializeTools(on ? [...rest, name] : rest, all);
}

/** "Back to the essentials plus my extras": leaves the opt-in `all` while keeping what was chosen on top. */
export function leaveAll(raw: unknown): string | null {
  return serializeTools(parseAgentTools(raw), false);
}

/**
 * The refusal as a person reads it: the server's sentence without its trailing roll-call of every valid tool name (about 190 of
 * them, which answers an API caller and buries a person). The first sentence names what was wrong, which is the useful part.
 */
export function plainProblem(message: string): string {
  return message.replace(/\s*Valid names:[\s\S]*$/, '').trim();
}

/** The server's own words for a refused write (`validateAgentSettings`), so the screen can say it before the round trip. */
export function toolsProblem(text: string | null): string | null {
  return validateAgentSettings({ tools: text })[0]?.message ?? null;
}

// ---------- Model ----------

/** The names the Runner passes to the tool's `--model` flag. The three are Claude Code's own aliases; the API stores the text as written. */
export const MODEL_CHOICES: ReadonlyArray<{ value: string; label: string; tradeoff: string }> = [
  { value: 'opus', label: 'Opus', tradeoff: 'The most capable, uses your limit fastest' },
  { value: 'sonnet', label: 'Sonnet', tradeoff: 'A good balance' },
  { value: 'haiku', label: 'Haiku', tradeoff: 'The quickest, uses the least' },
];

/** The workspace default, as stored (`settings.default_agent_model`); empty or absent = pass nothing = the tool's own default. */
export const TOOL_DEFAULT_LABEL = 'Claude Code’s own default';

export function modelLabel(value: string | null | undefined): string {
  if (!value) return TOOL_DEFAULT_LABEL;
  return MODEL_CHOICES.find((m) => m.value === value)?.label ?? value;
}

export function readModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The sentinel option value for "follow the workspace". */
export const FOLLOW_WORKSPACE = 'ws';

export interface AgentModelView {
  /** The option the menu shows as chosen. */
  selected: string;
  /** Options in order: the workspace default first, then the three, then a saved value this page does not know (kept, not lost). */
  options: Array<{ value: string; label: string; tradeoff?: string }>;
  /** The line under the menu. `reset` = the "Reset to the workspace default" link follows it. */
  note: string;
  reset: boolean;
}

export function agentModelView(agentModel: string | null, workspaceDefault: string | null): AgentModelView {
  const wsLabel = modelLabel(workspaceDefault);
  const known = agentModel ? MODEL_CHOICES.some((m) => m.value === agentModel) : true;
  const options: AgentModelView['options'] = [
    { value: FOLLOW_WORKSPACE, label: `Workspace default (${wsLabel})` },
    ...MODEL_CHOICES.map((m) => ({ value: m.value, label: m.label, tradeoff: m.tradeoff })),
    ...(agentModel && !known ? [{ value: agentModel, label: agentModel, tradeoff: 'Set outside this page' }] : []),
  ];
  if (!agentModel) {
    return { selected: FOLLOW_WORKSPACE, options, note: `Uses the workspace default (${wsLabel}). Change it for this agent only.`, reset: false };
  }
  return { selected: agentModel, options, note: `Only this agent uses ${modelLabel(agentModel)}.`, reset: true };
}

/** What a menu pick stores: the workspace sentinel is null (the agent follows the workspace), anything else is the text itself. */
export function modelToStore(pick: string): string | null {
  return pick === FOLLOW_WORKSPACE ? null : pick;
}

export function modelProblem(text: string | null): string | null {
  return validateAgentSettings({ model: text })[0]?.message ?? null;
}

/** Cursor chooses its own model from the person's plan; there is no Cursor adapter yet, so the control is disabled when it is the assigned tool. */
export function modelControllable(chosenTool: string | null | undefined): boolean {
  return chosenTool !== 'cursor';
}

/** The workspace-default menu (Agent rules): Sonnet, Opus, Haiku, then the tool's own default, which is stored as null. */
export const WORKSPACE_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'tool', label: TOOL_DEFAULT_LABEL },
];

export function workspaceModelSelected(stored: string | null | undefined): string {
  return stored ? stored : 'tool';
}

export function workspaceModelToStore(pick: string): string | null {
  return pick === 'tool' ? null : pick;
}

// ---------- Who ----------

/**
 * Who may change these: whoever may update records in the Agents database (the server's own bar, `contributor`, for the agent's
 * instructions and these two fields). A viewer or commenter, and a guest with only read, sees them read-only. `undefined` (not loaded yet) is "not yet".
 */
export function canEditAgentSettings(myAccess: EffectiveRole | undefined | null): boolean {
  return atLeast(myAccess ?? undefined, 'contributor');
}

/** The line a person who cannot edit reads. `owner` is the agent's manager by name, or null when it is not known. */
export function readOnlyLine(ownerName: string | null): string {
  return `Only ${ownerName ?? 'its owner'}, who manages this agent, can change these.`;
}

/** The workspace default is an admin setting, like the rest of Agent rules; the API refuses anyone else and any token (session only). */
export function canEditWorkspaceModel(role: string | undefined): boolean {
  return role === 'admin';
}
