import { describe, expect, it } from 'vitest';
import {
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
  it('never claims an audit export or a per-action authorisation chain, and says they are missing', () => {
    const claims = ENFORCED_RULES.map((r) => `${r.title} ${r.detail}`).join(' ').toLowerCase();
    expect(claims).not.toMatch(/audit (trail|export|pack)/);
    expect(claims).not.toMatch(/full (audit|history)/);
    const missing = NOT_COVERED.join(' ');
    expect(missing).toMatch(/no audit export/);
    expect(missing).toMatch(/not linked to the credential/);
  });
});
