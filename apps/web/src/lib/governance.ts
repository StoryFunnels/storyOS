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
};

/** "Updated “Fix the header”": what the action did, in words. An event type this page has no word for is shown as itself, not hidden. */
export function describeAction(row: Pick<AuditEventRow, 'type' | 'payload'>): string {
  const verb = (row.type && ACTION_VERB[row.type]) ?? row.type ?? 'Changed';
  const title = typeof row.payload?.['title'] === 'string' ? (row.payload['title'] as string).trim() : '';
  return title ? `${verb} “${title}”` : `${verb} a record`;
}

/** Only the rows an agent or a token made: the page lists those, never a person's own edits. */
export function isAgentAction(row: Pick<AuditEventRow, 'kind' | 'source'>): boolean {
  return row.kind === 'event' && (row.source === 'agent' || row.source === 'mcp');
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
  steps.push({ label: 'Action', value: `${describeAction(row)} · ${fmt(row.created_at)}` });
  return steps;
}

const SCOPE_WORDS_LONG: Record<Scope, string> = {
  read: 'Read only',
  write: 'Read and change records',
  admin: 'Everything, including settings',
};
