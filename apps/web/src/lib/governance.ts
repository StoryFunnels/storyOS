/**
 * The governance page's view-model (ticket #546), as pure functions so the claims the page makes
 * can be tested.
 *
 * THE RULE THIS FILE EXISTS FOR: the page is shown to a buyer, so it says only what the server
 * ENFORCES, and says it as narrowly as the enforcement is. Every sentence below is tied to a
 * mechanism that was read in the code, not to a capability that is merely declared:
 *
 *  - An agent's declared scopes cap what a run of that agent can do (`deriveAgentPrincipal`:
 *    owner scope intersected with the declared ceiling, declaring nothing means read).
 *  - An agent's declared approval policy holds the listed kinds of step for a person.
 *  - A workspace gate policy holds a class of action ONLY IF the server enforces that class; the
 *    API reports `enforced` and says why not (`inert_reason`), and this file never reports an
 *    unenforced policy as protecting anything.
 *  - An approval is decided by a person, once (assertHumanSource, and the atomic
 *    pending -> decided transition).
 *
 * What is deliberately NOT here: a claim of an audit export. None exists, so the page says so instead
 * of leaving a gap that reads as coverage. The per-action chain (ticket #934) IS here, but only as far as it
 * was recorded: an action names its credential when one was recorded (ticket #882) and says in words when
 * none was, never a chain with a blank link.
 */

export type Scope = 'read' | 'write' | 'admin';

const SCOPE_RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 };

export interface AgentRecord {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

export interface OptionLike {
  id: string;
  label: string;
}

export interface FieldLike {
  apiName: string;
  options?: OptionLike[];
}

/** A multi-select stores option ids; the page reasons in labels. Unknown ids are dropped, not shown. */
export function labelsOf(value: unknown, field: FieldLike | undefined): string[] {
  if (!Array.isArray(value) || !field?.options) return [];
  const byId = new Map(field.options.map((o) => [o.id, o.label]));
  return value.map((id) => byId.get(String(id))).filter((l): l is string => Boolean(l));
}

export interface AgentPosture {
  id: string;
  name: string;
  enabled: boolean;
  /** The highest scope the agent declares; `read` when it declares none (least privilege is the floor). */
  scopeCeiling: Scope;
  declaredScopes: Scope[];
  /** Kinds of step the agent's own policy holds for a person's approval. */
  holds: string[];
  /** Plain statements, most important first. Never empty. */
  notes: Array<{ tone: 'plain' | 'warn'; text: string }>;
}

function isScope(s: string): s is Scope {
  return s === 'read' || s === 'write' || s === 'admin';
}

export function describeAgent(agent: AgentRecord, fields: FieldLike[]): AgentPosture {
  const byApi = new Map(fields.map((f) => [f.apiName, f]));
  const declared = labelsOf(agent.values['scopes'], byApi.get('scopes')).filter(isScope);
  const holds = labelsOf(agent.values['approval_policy'], byApi.get('approval_policy'));
  const scopeCeiling = declared.reduce<Scope>((hi, s) => (SCOPE_RANK[s] > SCOPE_RANK[hi] ? s : hi), 'read');
  const enabled = agent.values['enabled'] === true;

  const notes: AgentPosture['notes'] = [];
  // A disabled agent is a definition, not a runnable thing (StoryOS refuses to run it), so its
  // scope is not a live exposure and must not be flagged as one.
  if (!enabled) {
    notes.push({ tone: 'plain', text: 'Switched off. StoryOS will not run it.' });
    return { id: agent.id, name: agent.title, enabled, scopeCeiling, declaredScopes: declared, holds, notes };
  }
  if (declared.length === 0) {
    notes.push({ tone: 'plain', text: 'Declares no scope, so a run is limited to reading.' });
  } else if (scopeCeiling === 'admin') {
    notes.push({ tone: 'warn', text: 'Declares admin scope. A run can do anything its owner can do.' });
  } else if (scopeCeiling === 'write') {
    notes.push({ tone: 'plain', text: 'Can read and change records, up to what its owner can.' });
  } else {
    notes.push({ tone: 'plain', text: 'Can read, not change.' });
  }
  if (scopeCeiling !== 'read' && holds.length === 0) {
    notes.push({
      tone: 'warn',
      text: 'Its own policy holds nothing for a person to approve first.',
    });
  } else if (holds.length > 0) {
    notes.push({ tone: 'plain', text: `A person must approve: ${holds.join(', ')}.` });
  }
  return { id: agent.id, name: agent.title, enabled, scopeCeiling, declaredScopes: declared, holds, notes };
}

export interface GatePolicyDto {
  id: string;
  space_id: string | null;
  database_id: string | null;
  action_class: string;
  enabled: boolean;
  enforced: boolean;
  inert_reason: string | null;
  approver_id: string;
}

const CLASS_PLAIN: Record<string, string> = {
  delete_records: 'Deleting records',
};

export interface GateRow {
  id: string;
  what: string;
  where: 'workspace' | 'space' | 'database';
  state: 'in_force' | 'off' | 'does_nothing';
  approverId: string;
  reason: string | null;
}

/** An unenforced policy is `does_nothing`, never `in_force`, whatever its enabled flag was stored as. */
export function describeGate(p: GatePolicyDto): GateRow {
  const state: GateRow['state'] = !p.enforced ? 'does_nothing' : p.enabled ? 'in_force' : 'off';
  return {
    id: p.id,
    what: CLASS_PLAIN[p.action_class] ?? p.action_class,
    where: p.database_id ? 'database' : p.space_id ? 'space' : 'workspace',
    state,
    approverId: p.approver_id,
    reason: p.enforced ? null : p.inert_reason,
  };
}

const GATE_ORDER: Record<GateRow['state'], number> = { in_force: 0, off: 1, does_nothing: 2 };

/** What protects you first; what only looks like protection last. */
export function orderGates(rows: GateRow[]): GateRow[] {
  return [...rows].sort((a, b) => GATE_ORDER[a.state] - GATE_ORDER[b.state]);
}

export function gatesInForce(rows: GateRow[]): GateRow[] {
  return rows.filter((r) => r.state === 'in_force');
}

export interface ApprovalDto {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | string;
  preview_text: string | null;
  approver_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

export interface ApprovalSummary {
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
}

/**
 * Counts over what the list returned. The list is the newest 100 only, so the page must say "of
 * the latest N", never present these as all-time totals (`truncated` is true when N hit the cap).
 */
export function summariseApprovals(rows: ApprovalDto[], cap = 100): ApprovalSummary & { shown: number; truncated: boolean } {
  const s = { pending: 0, approved: 0, rejected: 0, expired: 0 };
  for (const r of rows) {
    if (r.status === 'pending') s.pending += 1;
    else if (r.status === 'approved') s.approved += 1;
    else if (r.status === 'rejected') s.rejected += 1;
    else if (r.status === 'expired') s.expired += 1;
  }
  return { ...s, shown: rows.length, truncated: rows.length >= cap };
}

/** Rules the server enforces for every workspace, each phrased no wider than its mechanism. */
export const ENFORCED_RULES: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Only a person can approve or reject',
    detail:
      'An approval cannot be decided through an API token or a connected AI, even one acting for an admin. It has to be decided in the app by a signed-in person.',
  },
  {
    title: 'An approval is decided once',
    detail: 'The first decision stands. A second approve or reject on the same item changes nothing.',
  },
  {
    title: 'An agent never has more access than its owner',
    detail:
      'A run acts as its owner, limited to the highest scope the agent declares. An agent that declares nothing can only read.',
  },
  {
    title: 'Publishing to the outside is held for approval by default',
    detail:
      'An automation step that posts to social media waits for a person unless a workspace admin has turned that off in the automation. A member cannot save that change, and neither can an agent or a connected AI authoring on behalf of an admin.',
  },
];

/** What this page cannot tell you. Shown on the page; absence of these must never read as coverage. */
export const NOT_COVERED: ReadonlyArray<string> = [
  'There is no audit export yet. This page cannot hand you a file of what your agents did.',
  'Actions made through a sign-in session, an OAuth connection or an automation, and actions from before credentials were tracked, name no credential, because none was recorded. Their rows say so.',
  'Approval counts cover the latest 100 approvals only.',
];

export function ungovernedWorkspace(agents: AgentPosture[], inForce: GateRow[]): boolean {
  const active = agents.filter((a) => a.enabled && a.scopeCeiling !== 'read');
  return active.length > 0 && inForce.length === 0 && active.every((a) => a.holds.length === 0);
}

// ── Recent agent actions and their chain (ticket #934) ────────────────────────────────────────────────────────────
// Everything below reads what ticket #882 stamps on every write (the credential) and what ticket #541 does (the agent,
// and the member the action ran as). There is no second provenance store; a row is the audit log's event row.

/** One event row of GET /audit-log (admin). `credential_id` is null when no credential was recorded. */
export interface AuditEventRow {
  kind: 'event' | 'field_change';
  id: string;
  record_id: string;
  type?: string;
  actor_id: string | null;
  actor_name: string | null;
  source: string | null;
  credential_id?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

/** GET /credentials/:id — what a credential could reach, live or revoked. Carries no person. */
export interface CredentialDto {
  id: string;
  name: string;
  scope: Scope;
  origin: string | null;
  agent_id: string | null;
  resource_scope: { space_ids: string[]; database_ids: string[] } | null;
  created_at: string;
  revoked_at: string | null;
}

const ACTION_VERB: Record<string, string> = {
  'record.created': 'Created',
  'record.updated': 'Updated',
  'record.deleted': 'Deleted',
  'record.restored': 'Restored',
  'relation.linked': 'Linked',
  'relation.unlinked': 'Unlinked',
  'comment.created': 'Commented on',
  'attachment.added': 'Added a file to',
};

/** An event type this page has no word for, as plain words ("comment.added" becomes "Comment added"): never the dotted code itself. */
export function humaniseEventType(type: string): string {
  const words = type.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Changed';
}

/**
 * A wake rule (an Agent Triggers record) in words, derived from the rule's own fields (ticket #1284, Otto 2026-11-13): "a wake rule for
 * Onboarding Assistant: Clients' Status becomes Onboarding". DISPLAY ONLY: the stored record, its title and its fields are never
 * rewritten, and nothing here is written back. A part that cannot be resolved (a deleted agent, database, field or option) is left out
 * and the sentence stays neutral ("a wake rule"); it is never an id and never the stored `Agent ← Database.Field = Option` syntax.
 */
export interface TriggerFields {
  agent?: unknown;
  database?: unknown;
  state_field?: unknown;
  state_option?: unknown;
  relation_field?: unknown;
}

export interface TriggerNames {
  /** Resolves a bare agent id; the records API normally hands the agent over as `[{ id, title }]`, which needs no lookup. */
  agent: (id: string) => string | null;
  database: (id: string) => string | null;
  /** The field's display name and, for a select, a label for one option id; null when the field cannot be found. */
  field: (databaseId: string, fieldId: string) => { name: string; option: (id: string) => string | null } | null;
}

const idOf = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : null;
};

function agentNameOf(v: unknown, names: Pick<TriggerNames, 'agent'>): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (x && typeof x === 'object') {
    const title = (x as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  }
  return typeof x === 'string' && x ? names.agent(x) : null;
}

const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

export function triggerInWords(t: TriggerFields, names: TriggerNames): string {
  const agent = agentNameOf(t.agent, names);
  const subject = agent ? `a wake rule for ${agent}` : 'a wake rule';
  const dbId = idOf(t.database);
  const db = dbId ? names.database(dbId) : null;
  const stateFieldId = idOf(t.state_field);
  const relationFieldId = idOf(t.relation_field);
  const fieldId = stateFieldId ?? relationFieldId;
  const field = dbId && fieldId ? names.field(dbId, fieldId) : null;
  if (!field) return subject;
  const where = db ? `${possessive(db)} ${field.name}` : field.name;
  if (relationFieldId && !stateFieldId) return `${subject}: a record is linked in ${where}`;
  const optionId = idOf(t.state_option);
  const option = optionId ? field.option(optionId) : null;
  return `${subject}: ${where} ${option ? `becomes ${option}` : 'changes'}`;
}

/** The stored title of a wake rule is `Agent ← Database.Field = Option`: that exact shape is how a row recognises a trigger it cannot resolve (an ordinary title that merely contains an arrow is left alone). */
export function looksLikeTriggerTitle(title: string): boolean {
  return /^.+ ← .+\..+ (= .+|links it)$/.test(title);
}

/**
 * "Updated “Fix the header”": what the action did, in words. An event type this page has no word for is shown in plain words
 * (never as its dotted code), not hidden. The record's own title is data and is shown as it is, EXCEPT a wake rule: it is shown as
 * `triggerWords` (see `triggerInWords`), or, when its fields cannot be read, as "a wake rule" (never the stored trigger syntax).
 */
export function describeAction(row: Pick<AuditEventRow, 'type' | 'payload'>, triggerWords?: string | null): string {
  const known = row.type ? ACTION_VERB[row.type] : undefined;
  const raw = typeof row.payload?.['title'] === 'string' ? (row.payload['title'] as string).trim() : '';
  const isTrigger = Boolean(triggerWords) || looksLikeTriggerTitle(raw);
  const what = isTrigger ? (triggerWords ?? 'a wake rule') : raw ? `“${raw}”` : '';
  if (!known && row.type) return what ? `${humaniseEventType(row.type)} ${what}` : humaniseEventType(row.type);
  const verb = known ?? 'Changed';
  return `${verb} ${what || 'a record'}`;
}

/** Who the row is about: the agent when one is recorded, else the credential's name, else what kind of AI it was. Actor stays the member (shown as "for"). */
export function actionSubject(row: Pick<AuditEventRow, 'agent_name' | 'source'>, credential: Pick<CredentialDto, 'name'> | null | undefined): string {
  if (row.agent_name) return row.agent_name;
  if (credential?.name) return credential.name;
  return row.source === 'mcp' ? 'A connected AI' : 'An agent';
}

/** The small line under a row: the member it ran as, and the credential when one was recorded. A missing credential is said once above the list, not here. */
export function actionMeta(
  row: Pick<AuditEventRow, 'actor_name' | 'credential_id' | 'agent_name'>,
  credential: Pick<CredentialDto, 'name' | 'revoked_at'> | null | undefined,
): string {
  const parts: string[] = [];
  if (row.actor_name) parts.push(`for ${row.actor_name}`);
  if (row.credential_id) {
    // The credential's name already leads the row when it is the subject; only add it when the agent leads.
    const label = credential ? `${credential.name}${credential.revoked_at ? ' (revoked)' : ''}` : 'A credential';
    if (row.agent_name || !credential) parts.push(`credential ${label}`);
    else if (credential.revoked_at) parts.push('credential revoked');
  }
  return parts.join(' · ');
}

/** Said ONCE above the list when any row on it names no credential. */
export const NO_CREDENTIAL_NOTE =
  'Some actions name no credential. They were made before credentials were tracked, or through a sign-in session or an OAuth connection.';

export function missingCredentialNote(rows: Array<Pick<AuditEventRow, 'credential_id'>>): string | null {
  return rows.some((r) => !r.credential_id) ? NO_CREDENTIAL_NOTE : null;
}

/**
 * Whether a write's `source` is an AI acting: an agent, or an MCP client acting as the member. This is the ONE rule for "gold means an
 * AI acted" on a source badge (ticket #831/#1163): the Activity panel's badge, the record history's badge and this page's own list all
 * read it, so they cannot decide separately and drift. An automation is a rule a person configured that fired deterministically, so it
 * is NOT an AI source (Dara, ticket #1206); a person and an unrecorded source are not either.
 */
export function isAiSource(source: string | null | undefined): boolean {
  return source === 'agent' || source === 'mcp';
}

/** Only the rows an agent or a token made: the page lists those, never a person's own edits. */
export function isAgentAction(row: Pick<AuditEventRow, 'kind' | 'source'>): boolean {
  return row.kind === 'event' && isAiSource(row.source);
}

/**
 * What a row says when NO credential was recorded. It never shows a chain with a blank link and never a confident "unknown": it says
 * what is true — nothing was recorded — and the three ways that happens.
 */
export const NO_CREDENTIAL_WORDS =
  'No credential was recorded for this action. It was made before credentials were tracked, or through a sign-in session or an OAuth connection.';

/** "Everything its owner could reach" for an unrestricted credential, else the spaces and databases it is bound to, by name. */
export function reachWords(
  scope: CredentialDto['resource_scope'],
  names: { space: (id: string) => string | null; database: (id: string) => string | null },
): string {
  if (!scope) return 'Everything the person who made it could reach';
  const parts = [
    ...scope.space_ids.map((id) => `the space “${names.space(id) ?? 'a deleted space'}”`),
    ...scope.database_ids.map((id) => `the database “${names.database(id) ?? 'a deleted database'}”`),
  ];
  return parts.length === 0 ? 'Nothing (bound to no space or database)' : `Only ${parts.join(' and ')}`;
}

export interface ChainStep {
  label: string;
  value: string;
  /** Said when the link is known to be absent, so a gap reads as a gap and not as a blank. */
  absent?: boolean;
}

/**
 * The FULL chain behind one action, link by link: the member it ran as, the credential, the agent, then the action itself. A link that
 * was not recorded is a step that says so (`absent`), not a missing row.
 */
export function chainOf(
  row: AuditEventRow,
  credential: CredentialDto | null | undefined,
  names: { space: (id: string) => string | null; database: (id: string) => string | null },
  fmt: (iso: string) => string,
  triggerWords?: string | null,
): ChainStep[] {
  const steps: ChainStep[] = [
    { label: 'Authorised for', value: row.actor_name ?? 'Nobody was recorded', absent: !row.actor_name },
  ];
  if (!row.credential_id) {
    steps.push({ label: 'Credential', value: NO_CREDENTIAL_WORDS, absent: true });
  } else if (!credential) {
    steps.push({ label: 'Credential', value: 'This credential could not be loaded.', absent: true });
  } else {
    const state = credential.revoked_at ? `Revoked ${fmt(credential.revoked_at)}` : 'Live';
    steps.push({ label: 'Credential', value: `${credential.name} · ${state}` });
    steps.push({ label: 'Could reach', value: reachWords(credential.resource_scope, names) });
    steps.push({ label: 'Allowed to', value: SCOPE_WORDS_LONG[credential.scope] });
  }
  if (row.agent_name) steps.push({ label: 'Agent', value: row.agent_name });
  steps.push({ label: 'Action', value: `${describeAction(row, triggerWords)} · ${fmt(row.created_at)}` });
  return steps;
}

const SCOPE_WORDS_LONG: Record<Scope, string> = {
  read: 'Read only',
  write: 'Read and change records',
  admin: 'Everything, including settings',
};
