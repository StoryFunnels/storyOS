import { describe, expect, it } from 'vitest';
import { agentProposedActionOf, parseApprovalSnapshot, snapshotDatabaseId } from './approval-snapshot';

/** Ticket #1298 - the one reading of an approval snapshot. The unreadable cases, and (the half that is easy to forget) what must STAY readable. */
const ctx = { workspaceId: 'w', databaseId: 'd', recordId: 'r', actorId: 'u' };

describe('parseApprovalSnapshot - unreadable', () => {
  const cases: Array<[string, unknown, string]> = [
    ['the real one {"kind":"send_email"}', { kind: 'send_email' }, 'no_action'],
    ['null', null, 'not_an_object'],
    ['undefined', undefined, 'not_an_object'],
    ['a string', 'x', 'not_an_object'],
    ['a number', 1, 'not_an_object'],
    ['an array', [], 'not_an_object'],
    ['an array holding a valid-looking snapshot', [{ action: { type: 'a' }, ctx }], 'not_an_object'],
    ['action is a string', { action: 'send_email', ctx }, 'no_action'],
    ['action is null', { action: null, ctx }, 'no_action'],
    ['action has no type', { action: {}, ctx }, 'bad_action_type'],
    ['action.type is a number', { action: { type: 3 }, ctx }, 'bad_action_type'],
    ['no ctx', { action: { type: 'send_email' } }, 'no_ctx'],
    ['ctx is null', { action: { type: 'send_email' }, ctx: null }, 'no_ctx'],
    ['ctx is a string', { action: { type: 'send_email' }, ctx: 'd' }, 'no_ctx'],
    ['ctx has no databaseId key at all', { action: { type: 'send_email' }, ctx: { workspaceId: 'w' } }, 'bad_database_id'],
    ['ctx.databaseId is a number', { action: { type: 'send_email' }, ctx: { databaseId: 7 } }, 'bad_database_id'],
  ];
  it.each(cases)('%s', (_name, raw, reason) => {
    expect(parseApprovalSnapshot(raw)).toEqual({ readable: false, reason });
  });
});

describe('parseApprovalSnapshot - must STAY readable (every producer shape, and the minimal ones other suites seed)', () => {
  const readable: Array<[string, unknown]> = [
    ['an automation action', { action: { type: 'add_comment', body_template: 'x', require_approval: true }, ctx }],
    ['a skill (belongs to no database: databaseId null)', { action: { type: 'skill_publish_public', skill_id: 's', skill_name: 'n', requester_source: 'human' }, ctx: { ...ctx, databaseId: null, recordId: null } }],
    ['one an agent caused (ctx.origin present)', { action: { type: 'send_webhook', url: 'https://example.test' }, ctx: { ...ctx, origin: { agentId: 'a', agentName: 'A', runId: 'r', runnerId: 'x', runnerName: 'R' } } }],
    ['a held write-back push', { action: { type: 'write_back_push', action_class: 'c', source_id: 's', external_key: 'k', values: {} }, ctx }],
    ['an agent-run proposal', { action: { type: 'agent_proposed_action', runs_db_id: 'd', run_id: 'r', proposed: {}, steps: [] }, ctx }],
    ['the minimal snapshot the My work suite seeds', { ctx: { databaseId: 'd' }, action: { type: 'send_webhook' } }],
  ];
  it.each(readable)('%s', (_name, raw) => {
    const parsed = parseApprovalSnapshot(raw);
    expect(parsed.readable).toBe(true);
    if (parsed.readable) expect(parsed.snapshot).toBe(raw); // the SAME object: nothing is rewritten, so nothing a producer wrote is lost
  });
});

describe('agentProposedActionOf', () => {
  const row = (actionSnapshot: unknown) => ({ id: 'row-agent-1', actionSnapshot });
  it('returns the proposal for an agent-run snapshot, null for any other kind, and null (not a throw) for an unreadable one', () => {
    const proposal = { type: 'agent_proposed_action', runs_db_id: 'd', run_id: 'r', proposed: {}, steps: [] };
    expect(agentProposedActionOf(row({ action: proposal, ctx }))).toBe(proposal);
    expect(agentProposedActionOf(row({ action: { type: 'send_email' }, ctx }))).toBeNull();
    expect(agentProposedActionOf(row({ kind: 'send_email' }))).toBeNull();
    expect(agentProposedActionOf(row(null))).toBeNull();
    expect(agentProposedActionOf(null)).toBeNull();
    expect(agentProposedActionOf(undefined)).toBeNull();
  });
});

describe('snapshotDatabaseId (access reads ctx.databaseId alone)', () => {
  it('reads it even when the action is the broken part, and says "cannot tell" otherwise', () => {
    expect(snapshotDatabaseId({ type: 'add_comment', ctx: { databaseId: 'd' } })).toBe('d');
    expect(snapshotDatabaseId({ ctx: { databaseId: null } })).toBeNull();
    for (const bad of [null, 'x', [], {}, { ctx: null }, { ctx: {} }, { ctx: { databaseId: 3 } }]) expect(snapshotDatabaseId(bad)).toBeUndefined();
  });
});
