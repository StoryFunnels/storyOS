import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { approvals } from '../src/db/schema';
import { AgentsService } from '../src/agents/agents.service';
import { RecordsService } from '../src/records/records.service';
import { AutomationActionsService as ActionsService } from '../src/automations/actions.service';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';

/**
 * #1029 — approving an agent run could delete, overwrite or exfiltrate records in ANY workspace. Two doors:
 *  (1) a run record forged in the attacker's own workspace (status "Waiting approval", a hand-written `pending_action`
 *      naming a victim's ids): approve trusted that user-editable field;
 *  (2) a REAL parked run whose proposed payload names a victim's ids (prompt injection, or a forged edit of the payload):
 *      the apply paths read by record id alone.
 * Each test attacks as the attacker and then looks at the VICTIM's record, because "the call failed" is not the same
 * fact as "nothing happened".
 */
let app: NestFastifyApplication;
let attacker: { token: string };
let victim: { token: string };
let wsA: string, wsB: string;
let runsA: string, agentsA: string, issuesA: string;
let victimDb: string, victimRec: string;
const { db } = connectTestDb();

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

interface F { id: string; apiName: string; options?: Array<{ id: string; label: string }> }
const fieldsOf = async (token: string, ws: string, dbId: string) =>
  new Map<string, F>(((await as(token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json().fields as F[]).map((f) => [f.apiName, f]));
const opt = (f: F | undefined, label: string) => f!.options!.find((o) => o.label === label)!.id;

const victimRecord = async () => as(victim.token, 'GET', `/workspaces/${wsB}/databases/${victimDb}/records/${victimRec}`);
const expectVictimUntouched = async () => {
  const res = await victimRecord();
  expect(res.statusCode, 'the victim record must still be readable').toBe(200);
  expect(res.json().title, 'and unchanged').toBe('Victim secret');
};

async function createAgent(name: string) {
  const f = await fieldsOf(attacker.token, wsA, agentsA);
  const res = await as(attacker.token, 'POST', `/workspaces/${wsA}/databases/${agentsA}/records`, {
    values: { name, enabled: true, scopes: [opt(f.get('scopes'), 'admin')], approval_policy: [opt(f.get('approval_policy'), 'delete')] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function park(agentId: string, action: ProposedAction) {
  const runtime: AgentRuntime = {
    runClass: 'non_ai',
    async *execute() { yield { tool: 'propose', summary: action.summary, action }; },
  };
  const svc = app.get(AgentsService);
  const original = svc.runtimeFor;
  svc.runtimeFor = () => runtime;
  try {
    const res = await as(attacker.token, 'POST', `/workspaces/${wsA}/agents/${agentId}/run`);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  } finally { svc.runtimeFor = original; }
}
const approve = (run: string) => as(attacker.token, 'POST', `/workspaces/${wsA}/agents/runs/${run}/approve`);

beforeAll(async () => {
  app = await createTestApp();
  attacker = await signUpUser(app, 'Attacker');
  victim = await signUpUser(app, 'Victim');
  wsA = (await as(attacker.token, 'POST', '/workspaces', { name: 'Attacker WS' })).json().id;
  wsB = (await as(victim.token, 'POST', '/workspaces', { name: 'Victim WS' })).json().id;
  const ens = (await as(attacker.token, 'POST', `/workspaces/${wsA}/agents/ensure`)).json();
  agentsA = ens.agentsDb.id; runsA = ens.runsDb.id;
  const spaceA = (await as(attacker.token, 'POST', `/workspaces/${wsA}/spaces`, { name: 'Work' })).json();
  issuesA = (await as(attacker.token, 'POST', `/workspaces/${wsA}/databases`, { space_id: spaceA.id, name: 'Issues' })).json().id;
  const spaceB = (await as(victim.token, 'POST', `/workspaces/${wsB}/spaces`, { name: 'Private' })).json();
  victimDb = (await as(victim.token, 'POST', `/workspaces/${wsB}/databases`, { space_id: spaceB.id, name: 'Secrets' })).json().id;
  victimRec = (await as(victim.token, 'POST', `/workspaces/${wsB}/databases/${victimDb}/records`, { values: { name: 'Victim secret' } })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1029 door 1: a forged run record', () => {
  it('a "Waiting approval" run with a hand-written pending_action naming the victim record deletes NOTHING', async () => {
    const f = await fieldsOf(attacker.token, wsA, runsA);
    const forged = JSON.stringify({
      action: { kind: 'delete', summary: 'x', payload: { apply: 'record_delete', database_id: victimDb, record_id: victimRec } },
      // The attacker's OWN user id and a valid scope: the forgery is as good as a person can make it.
      steps: [], principal: { userId: (await db.query.memberships.findFirst({ where: (m, { eq: e }) => e(m.workspaceId, wsA) }))!.userId, scope: 'admin' },
    });
    const run = await as(attacker.token, 'POST', `/workspaces/${wsA}/databases/${runsA}/records`, {
      values: { name: 'forged', status: opt(f.get('status'), 'Waiting approval'), pending_action: forged },
    });
    expect(run.statusCode, run.body).toBe(201);
    const res = await approve(run.json().id);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body, 'refused because nothing server-side staged it, not for some other reason').toContain('no server-side approval');
    await expectVictimUntouched();
  });

  it('editing the pending_action of a REAL parked run cannot redirect it: the server-staged action is what runs', async () => {
    const own = (await as(attacker.token, 'POST', `/workspaces/${wsA}/databases/${issuesA}/records`, { values: { name: 'Mine' } })).json();
    const agent = await createAgent('Honest');
    const run = await park(agent.id, { kind: 'delete', summary: 'delete mine', payload: { apply: 'record_delete', database_id: issuesA, record_id: own.id } });
    const forged = JSON.parse(run.values.pending_action as string);
    forged.action.payload = { apply: 'record_delete', database_id: victimDb, record_id: victimRec };
    expect((await as(attacker.token, 'PATCH', `/workspaces/${wsA}/databases/${runsA}/records/${run.id}`, { values: { pending_action: JSON.stringify(forged) } })).statusCode).toBe(200);

    const res = await approve(run.id);
    expect(res.statusCode, res.body).toBe(201);
    await expectVictimUntouched();
    expect((await as(attacker.token, 'GET', `/workspaces/${wsA}/databases/${issuesA}/records/${own.id}`)).statusCode, 'the ORIGINAL staged delete ran').toBe(404);
  });

  it('the Inbox view of a parked run shows the server-staged action, not the editable copy', async () => {
    const own = (await as(attacker.token, 'POST', `/workspaces/${wsA}/databases/${issuesA}/records`, { values: { name: 'Shown' } })).json();
    const run = await park((await createAgent('Shown')).id, { kind: 'delete', summary: 'delete shown', payload: { apply: 'record_delete', database_id: issuesA, record_id: own.id } });
    const forged = JSON.parse(run.values.pending_action as string);
    forged.action.summary = 'totally harmless';
    await as(attacker.token, 'PATCH', `/workspaces/${wsA}/databases/${runsA}/records/${run.id}`, { values: { pending_action: JSON.stringify(forged) } });
    const staged = await app.get(AgentsService).getStagedAction({ workspaceId: wsA, userId: (await db.query.memberships.findFirst({ where: (m, { eq: e }) => e(m.workspaceId, wsA) }))!.userId, role: 'admin' } as never, run.id);
    expect(staged?.action.summary).toBe('delete shown');
  });
});

describe('#1029 door 2: a real run whose staged payload names another workspace', () => {
  it('record_delete on a victim record: approve is refused and the victim record is untouched', async () => {
    const agent = await createAgent('Injected delete');
    const run = await park(agent.id, { kind: 'delete', summary: 'delete', payload: { apply: 'record_delete', database_id: victimDb, record_id: victimRec } });
    const res = await approve(run.id);
    expect(res.statusCode, res.body).toBe(404);
    await expectVictimUntouched();
  });

  it('automation_action set_values on a victim record: approve is refused and the victim record is unchanged', async () => {
    const agent = await createAgent('Injected overwrite');
    const run = await park(agent.id, {
      kind: 'delete', summary: 'overwrite', // gated by the same policy; the PAYLOAD is what does the overwriting
      payload: { apply: 'automation_action', database_id: victimDb, record_id: victimRec, action: { type: 'set_values', values: { name: 'PWNED' } } },
    });
    const res = await approve(run.id);
    expect(res.statusCode, res.body).toBe(404);
    await expectVictimUntouched();
  });

  it('a refused approve leaves the gate OPEN (the run stays parked, the approvals row stays pending)', async () => {
    const run = await park((await createAgent('Stays parked')).id, { kind: 'delete', summary: 'd', payload: { apply: 'record_delete', database_id: victimDb, record_id: victimRec } });
    expect((await approve(run.id)).statusCode).toBe(404);
    const row = await db.query.approvals.findFirst({ where: eq(approvals.runId, run.id) });
    expect(row?.status).toBe('pending');
  });
});

describe('#1029 the services themselves refuse a database from another workspace', () => {
  it('RecordsService.softDelete and .update reject a cross-workspace id pair', async () => {
    const records = app.get(RecordsService);
    await expect(records.softDelete(wsA, victimDb, victimRec, 'someone')).rejects.toThrow(/Database not found/);
    await expect(records.update(wsA, victimDb, victimRec, { name: 'PWNED' }, 'someone')).rejects.toThrow(/Database not found/);
    await expectVictimUntouched();
  });

  it('ActionsService.validate and .execute reject a ctx.databaseId outside ctx.workspaceId', async () => {
    const actions = app.get(ActionsService);
    await expect(actions.validate(victimDb, wsA, [{ type: 'set_values', values: { name: 'x' } } as never])).rejects.toThrow(/Database not found/);
    const record = (await victimRecord()).json();
    await expect(actions.execute([{ type: 'set_values', values: { name: 'PWNED' } } as never], { workspaceId: wsA, databaseId: victimDb, record, actorId: 'someone', depth: 0 } as never)).rejects.toThrow(/Database not found/);
    await expectVictimUntouched();
  });

  it('the legitimate same-workspace paths still work', async () => {
    const own = (await as(attacker.token, 'POST', `/workspaces/${wsA}/databases/${issuesA}/records`, { values: { name: 'Legit' } })).json();
    const records = app.get(RecordsService);
    expect((await records.update(wsA, issuesA, own.id, { name: 'Legit 2' }, null)).title).toBe('Legit 2');
    expect(await records.softDelete(wsA, issuesA, own.id, 'someone')).toEqual({ deleted: true });
  });
});
