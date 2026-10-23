import { describe, expect, it } from 'vitest';
import {
  NO_CREDENTIAL_WORDS,
  chainOf,
  describeAction,
  isAgentAction,
  reachWords,
  type AuditEventRow,
  type CredentialDto,
  ENFORCED_RULES,
  NOT_COVERED,
  describeAgent,
  describeGate,
  gatesInForce,
  orderGates,
  labelsOf,
  summariseApprovals,
  ungovernedWorkspace,
  type ApprovalDto,
  type GatePolicyDto,
} from './governance';

const fields = [
  { apiName: 'scopes', options: [{ id: 's1', label: 'read' }, { id: 's2', label: 'write' }, { id: 's3', label: 'admin' }] },
  { apiName: 'approval_policy', options: [{ id: 'p1', label: 'delete' }, { id: 'p2', label: 'email' }] },
];
const agent = (values: Record<string, unknown>) => ({ id: 'a', title: 'Writer', values });

describe('describeAgent', () => {
  it('declaring nothing is read-only, never "whatever the owner has"', () => {
    const a = describeAgent(agent({ enabled: true }), fields);
    expect(a.scopeCeiling).toBe('read');
    expect(a.notes[0]?.text).toMatch(/limited to reading/);
  });

  it('takes the HIGHEST declared scope, not the first or last', () => {
    expect(describeAgent(agent({ scopes: ['s3', 's1'], enabled: true }), fields).scopeCeiling).toBe('admin');
    expect(describeAgent(agent({ scopes: ['s1', 's2'], enabled: true }), fields).scopeCeiling).toBe('write');
  });

  it('an unknown option id is dropped rather than shown or trusted', () => {
    expect(labelsOf(['s1', 'nope'], fields[0])).toEqual(['read']);
    expect(describeAgent(agent({ scopes: ['nope'], enabled: true }), fields).scopeCeiling).toBe('read');
  });

  it('a writing agent with no approval policy is flagged plainly, and one with a policy is not', () => {
    const bare = describeAgent(agent({ scopes: ['s2'], enabled: true }), fields);
    expect(bare.notes.some((n) => n.tone === 'warn' && /holds nothing for a person/.test(n.text))).toBe(true);
    const held = describeAgent(agent({ scopes: ['s2'], approval_policy: ['p1'], enabled: true }), fields);
    expect(held.notes.some((n) => /must approve: delete/.test(n.text))).toBe(true);
    expect(held.notes.some((n) => n.tone === 'warn' && /holds nothing for a person/.test(n.text))).toBe(false);
  });

  it('a read-only agent is not told it needs approval holds', () => {
    const r = describeAgent(agent({ scopes: ['s1'], enabled: true }), fields);
    expect(r.notes.every((n) => !/held for approval/.test(n.text))).toBe(true);
  });

  it('a disabled agent says so, and is not flagged as an exposure', () => {
    const off = describeAgent(agent({ scopes: ['s3'] }), fields);
    expect(off.notes).toEqual([{ tone: 'plain', text: 'Switched off. StoryOS will not run it.' }]);
  });
});

const gate = (over: Partial<GatePolicyDto>): GatePolicyDto => ({
  id: 'g', space_id: null, database_id: null, action_class: 'delete_records',
  enabled: true, enforced: true, inert_reason: null, approver_id: 'u', ...over,
});

describe('describeGate', () => {
  it('an unenforced policy is "does nothing" even when stored as enabled, and carries the reason', () => {
    const g = describeGate(gate({ action_class: 'spend_money', enforced: false, enabled: true, inert_reason: 'not enforced' }));
    expect(g.state).toBe('does_nothing');
    expect(g.reason).toBe('not enforced');
    expect(gatesInForce([g])).toEqual([]);
  });

  it('a disabled enforced policy is off, not in force', () => {
    expect(gatesInForce([describeGate(gate({ enabled: false }))])).toEqual([]);
  });

  it('an enforced enabled policy is in force, with its reach', () => {
    const g = describeGate(gate({ database_id: 'd' }));
    expect(g.state).toBe('in_force');
    expect(g.where).toBe('database');
    expect(describeGate(gate({ space_id: 's' })).where).toBe('space');
    expect(describeGate(gate({})).where).toBe('workspace');
  });
});

describe('orderGates', () => {
  it('lists what is in force before what is off or does nothing', () => {
    const rows = [
      describeGate(gate({ id: 'x', enforced: false })),
      describeGate(gate({ id: 'o', enabled: false })),
      describeGate(gate({ id: 'i' })),
    ];
    expect(orderGates(rows).map((r) => r.id)).toEqual(['i', 'o', 'x']);
  });
});

describe('ungovernedWorkspace', () => {
  const writer = describeAgent(agent({ scopes: ['s2'], enabled: true }), fields);
  it('writing agents, no holds and no gate: ungoverned', () => {
    expect(ungovernedWorkspace([writer], [])).toBe(true);
  });
  it('an in-force gate, or an agent-level hold, makes it not ungoverned', () => {
    expect(ungovernedWorkspace([writer], [describeGate(gate({}))])).toBe(false);
    const held = describeAgent(agent({ scopes: ['s2'], approval_policy: ['p1'], enabled: true }), fields);
    expect(ungovernedWorkspace([held], [])).toBe(false);
  });
  it('an inert gate does NOT rescue it: the page must not look governed because a policy exists', () => {
    const inert = describeGate(gate({ enforced: false }));
    expect(ungovernedWorkspace([writer], gatesInForce([inert]))).toBe(true);
  });
  it('no agents, read-only agents or disabled agents are not "ungoverned"', () => {
    expect(ungovernedWorkspace([], [])).toBe(false);
    expect(ungovernedWorkspace([describeAgent(agent({ scopes: ['s1'], enabled: true }), fields)], [])).toBe(false);
    expect(ungovernedWorkspace([describeAgent(agent({ scopes: ['s2'] }), fields)], [])).toBe(false);
  });
});

describe('summariseApprovals', () => {
  const a = (status: string): ApprovalDto => ({
    id: status, status, preview_text: null, approver_id: null, decided_by: null, decided_at: null, reason: null, created_at: '',
  });
  it('counts by status and does not present a full page as a total', () => {
    const s = summariseApprovals([a('pending'), a('approved'), a('approved'), a('rejected'), a('expired')]);
    expect(s).toMatchObject({ pending: 1, approved: 2, rejected: 1, expired: 1, shown: 5, truncated: false });
    expect(summariseApprovals(Array.from({ length: 100 }, () => a('approved'))).truncated).toBe(true);
  });
});

describe('what the page claims', () => {
  it('never claims an audit export, and says what is missing', () => {
    const claims = ENFORCED_RULES.map((r) => `${r.title} ${r.detail}`).join(' ').toLowerCase();
    expect(claims).not.toMatch(/audit (trail|export|pack)/);
    expect(claims).not.toMatch(/full (audit|history)/);
    const missing = NOT_COVERED.join(' ');
    expect(missing).toMatch(/no audit export/);
    // #934: the chain IS shown now, so the old "cannot show which token authorised it" is gone; what remains true is said instead.
    expect(missing).not.toMatch(/cannot show, for a given action/);
    expect(missing).toMatch(/name no credential, because none was recorded/);
  });
});

describe('recent agent actions and their chain (ticket #934)', () => {
  const names = { space: (id: string) => (id === 's1' ? 'Support' : null), database: (id: string) => (id === 'd1' ? 'Tickets' : null) };
  const fmt = (iso: string) => `on ${iso.slice(0, 10)}`;
  const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
    kind: 'event', id: 'e1', record_id: 'r1', type: 'record.updated', actor_id: 'u1', actor_name: 'Alice', source: 'mcp',
    credential_id: 'c1', agent_id: null, agent_name: null, payload: { title: 'Fix the header' }, created_at: '2026-10-23T10:00:00Z', ...over,
  });
  const cred = (over: Partial<CredentialDto> = {}): CredentialDto => ({
    id: 'c1', name: 'ci robot', scope: 'write', origin: 'mcp', agent_id: null, resource_scope: null,
    created_at: '2026-10-01T00:00:00Z', revoked_at: null, ...over,
  });

  it('says what the action did, with the record title; an unknown event type is shown, not hidden', () => {
    expect(describeAction(row())).toBe('Updated “Fix the header”');
    expect(describeAction(row({ type: 'record.created', payload: {} }))).toBe('Created a record');
    expect(describeAction(row({ type: 'comment.added', payload: null }))).toBe('comment.added a record');
  });

  it('lists only what an agent or a token did — never a person’s own edit, never a field-change row', () => {
    expect(isAgentAction(row({ source: 'agent' }))).toBe(true);
    expect(isAgentAction(row({ source: 'mcp' }))).toBe(true);
    expect(isAgentAction(row({ source: 'human' }))).toBe(false);
    expect(isAgentAction(row({ source: 'automation' }))).toBe(false);
    expect(isAgentAction(row({ source: null }))).toBe(false);
    expect(isAgentAction(row({ kind: 'field_change', source: 'mcp' }))).toBe(false);
  });

  it('the FULL chain, link by link: member, credential, what it could reach, what it may do, agent, action', () => {
    const steps = chainOf(row({ agent_name: 'Triage' }), cred({ resource_scope: { space_ids: ['s1'], database_ids: ['d1'] } }), names, fmt);
    expect(steps.map((s) => s.label)).toEqual(['Authorised for', 'Credential', 'Could reach', 'Allowed to', 'Agent', 'Action']);
    expect(steps[0]!.value).toBe('Alice');
    expect(steps[1]!.value).toBe('ci robot · Live');
    expect(steps[2]!.value).toBe('Only the space “Support” and the database “Tickets”');
    expect(steps[3]!.value).toBe('Read and change records');
    expect(steps[5]!.value).toBe('Updated “Fix the header” · on 2026-10-23');
    expect(steps.some((s) => s.absent)).toBe(false);
  });

  it('a revoked credential still shows its chain, and says it is revoked', () => {
    const steps = chainOf(row(), cred({ revoked_at: '2026-10-22T00:00:00Z' }), names, fmt);
    expect(steps[1]!.value).toBe('ci robot · Revoked on 2026-10-22');
  });

  it('an unrestricted credential says so in words, and a deleted space or database is not a blank', () => {
    expect(reachWords(null, names)).toBe('Everything the person who made it could reach');
    expect(reachWords({ space_ids: ['gone'], database_ids: [] }, names)).toBe('Only the space “a deleted space”');
    expect(reachWords({ space_ids: [], database_ids: [] }, names)).toBe('Nothing (bound to no space or database)');
  });

  it('an action with NO recorded credential says so in words — not a chain with a blank link, not a confident "unknown"', () => {
    const steps = chainOf(row({ credential_id: null }), undefined, names, fmt);
    const credential = steps.find((s) => s.label === 'Credential')!;
    expect(credential.value).toBe(NO_CREDENTIAL_WORDS);
    expect(credential.absent).toBe(true);
    expect(steps.map((s) => s.label)).toEqual(['Authorised for', 'Credential', 'Action']); // no reach/scope lines invented
    expect(NO_CREDENTIAL_WORDS).not.toMatch(/unknown/i);
  });

  it('a credential that could not be loaded is said so, not rendered as if it had no credential', () => {
    const steps = chainOf(row(), null, names, fmt);
    expect(steps.find((s) => s.label === 'Credential')!.value).toBe('This credential could not be loaded.');
  });

  it('the member is named from the log, and a row with nobody recorded says that', () => {
    expect(chainOf(row({ actor_name: null }), cred(), names, fmt)[0]).toMatchObject({ value: 'Nobody was recorded', absent: true });
  });
});
