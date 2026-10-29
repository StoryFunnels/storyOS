import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { agentWriteGates, approvals, records } from '../src/db/schema';
import { AgentsService } from '../src/agents/agents.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { APPROVAL_POLICY_KINDS } from '../src/agents/agent-runtime';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';

/**
 * #1104 — a per-agent gate on record create/update, through the existing approvals flow.
 *
 * Premise (on main, before this change): an agent's own `approval_policy` can hold delete/webhook/email/run_button/outward and
 * nothing else, so an agent token's PATCH wrote straight through. The first describe pins that baseline and is the one block
 * that is GREEN on main; every block after it is red on main (there is no gate route, no 202, no executor).
 */
let app: NestFastifyApplication;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let candidatesId: string;
let otherDbId: string;
let notesApi: string;
let stageApi: string;
const { db, pool } = connectTestDb();

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

async function mkAgent(name: string): Promise<{ id: string; token: string }> {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, { values: { name, enabled: true } });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  const tok = await as(admin.token, 'POST', '/me/tokens', { name: `${name} token`, workspace_id: wsId, scope: 'admin', agent_id: id });
  expect(tok.statusCode, tok.body).toBe(201);
  return { id, token: tok.json().token as string };
}

async function mkRecord(dbId: string, values: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; title: string; values: Record<string, unknown> };
}

async function getRecord(dbId: string, id: string) {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; title: string; values: Record<string, unknown> };
}

async function gate(agentId: string, body: Record<string, unknown>, token = admin.token) {
  return as(token, 'POST', `/workspaces/${wsId}/agent-write-gates`, { agent_id: agentId, ...body });
}

async function countRecords(dbId: string) {
  return (await db.query.records.findMany({ where: and(eq(records.databaseId, dbId)) })).filter((r) => !r.deletedAt).length;
}

async function pendingFor(agentId: string) {
  const rows = await db.query.approvals.findMany({ where: eq(approvals.workspaceId, wsId) });
  return rows.filter((r) => {
    const a = (r.actionSnapshot as { action: { type: string; agent_id?: string } }).action;
    return a.type === 'agent_write_gate' && a.agent_id === agentId;
  });
}

beforeAll(async () => {
  app = await createTestApp();
  jobs = app.get(JobRunnerService);
  admin = await signUpUser(app, 'WriteGateAdmin');
  member = await signUpUser(app, 'WriteGateMember');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Write gates WS' })).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
  await as(member.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`)).json().agentsDb.id;
  const space = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Hiring' })).json();
  candidatesId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space.id, name: 'Candidates' })).json().id;
  otherDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space.id, name: 'Notes board' })).json().id;
  for (const dbId of [candidatesId, otherDbId]) {
    const n = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text', config: {} });
    expect(n.statusCode, n.body).toBe(201);
    notesApi = n.json().apiName;
    const s = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Stage', type: 'text', config: {} });
    stageApi = s.json().apiName;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('#1104 premise (green on main): an agent record write is not gateable today', () => {
  it('the gate list has no create/update, and an agent-token update goes straight through with no approval', async () => {
    expect(APPROVAL_POLICY_KINDS).toEqual(['delete', 'webhook', 'email', 'run_button', 'outward']);
    const agent = await mkAgent('Baseline Bot');
    const rec = await mkRecord(candidatesId, { name: 'Ada', [notesApi]: 'x' });
    const res = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [notesApi]: 'moved by agent' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await getRecord(candidatesId, rec.id)).values[notesApi]).toBe('moved by agent');
    expect(await pendingFor(agent.id)).toHaveLength(0);
  });
});

describe('#1104 declaring a gate', () => {
  it('an admin person declares one; a member, and an agent token even with admin scope, cannot', async () => {
    const agent = await mkAgent('Declared Bot');
    const ok = await gate(agent.id, { operations: ['update'], database_id: candidatesId, fields: [notesApi] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ agent_id: agent.id, operations: ['update'], database_id: candidatesId, fields: [notesApi], enabled: true });

    expect((await gate(agent.id, { operations: ['update'] }, member.token)).statusCode).toBe(403);
    // The gated agent must not be able to lift its own gate (#859's rule, applied to the declaration).
    const byAgent = await gate(agent.id, { operations: ['update'] }, agent.token);
    expect(byAgent.statusCode, byAgent.body).toBe(403);
    const del = await as(agent.token, 'DELETE', `/workspaces/${wsId}/agent-write-gates/${ok.json().id}`);
    expect(del.statusCode).toBe(403);
    expect(await db.query.agentWriteGates.findFirst({ where: eq(agentWriteGates.id, ok.json().id) })).toBeTruthy();
  });

  it('refuses a gate that could never work: unknown agent, fields without a database, unknown field, no operation', async () => {
    const agent = await mkAgent('Validated Bot');
    expect((await gate('00000000-0000-4000-8000-000000000000', { operations: ['update'] })).statusCode).toBe(404);
    expect((await gate(agent.id, { operations: ['update'], fields: [notesApi] })).statusCode).toBe(422);
    expect((await gate(agent.id, { operations: ['update'], database_id: candidatesId, fields: ['no_such_field'] })).statusCode).toBe(422);
    expect((await gate(agent.id, { operations: [] })).statusCode).toBe(422);
    expect(await db.query.agentWriteGates.findMany({ where: eq(agentWriteGates.agentId, agent.id) })).toHaveLength(0);
  });
});

describe('#1111 an agent\'s owner reads that agent\'s gates (read-only); everyone else keeps today\'s answer', () => {
  let owner: { token: string; email: string };
  let guest: { token: string; email: string };
  let ownedId: string;
  let adminAgent: { id: string; token: string };
  let gateId: string;
  const list = (token: string, agentId?: string) => as(token, 'GET', `/workspaces/${wsId}/agent-write-gates${agentId ? `?agent_id=${agentId}` : ''}`);
  const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Agent not found' } };

  beforeAll(async () => {
    owner = await signUpUser(app, 'WriteGateOwner');
    guest = await signUpUser(app, 'WriteGateGuest');
    for (const [u, role] of [[owner, 'member'], [guest, 'guest']] as const) {
      const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json().data?.[0]?.id ?? (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0]?.id;
      const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: u.email, role, ...(role === 'guest' ? { grants: [{ space_id: spaceId, role: 'viewer' }] } : {}) });
      expect(invite.statusCode, invite.body).toBe(201);
      await as(u.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
    }
    // the OWNER of an agent is the creator of its record: a member creates this one
    const made = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, { values: { name: 'Owned Bot', enabled: true } });
    expect(made.statusCode, made.body).toBe(201);
    ownedId = made.json().id;
    adminAgent = await mkAgent('Admin Owned Bot');
    const g = await gate(ownedId, { operations: ['update'], database_id: candidatesId });
    expect(g.statusCode, g.body).toBe(201);
    gateId = g.json().id;
    expect((await gate(adminAgent.id, { operations: ['create'] })).statusCode).toBe(201);
  });

  it('the owner (a member) lists THAT agent\'s gates, and only those; a read-scoped token of theirs does too', async () => {
    const res = await list(owner.token, ownedId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((g: { id: string }) => g.id)).toEqual([gateId]);
    const tok = await as(owner.token, 'POST', '/me/tokens', { name: 'owner read', workspace_id: wsId, scope: 'read' });
    expect(tok.statusCode, tok.body).toBe(201);
    expect((await list(tok.json().token, ownedId)).statusCode).toBe(200);
  });

  it('a non-owner member, and the owner asking about someone else\'s agent, hear the SAME 404 as an agent that does not exist', async () => {
    const unknown = await list(member.token, '00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject(NOT_FOUND_BODY);
    for (const res of [await list(member.token, ownedId), await list(owner.token, adminAgent.id), await list(owner.token, 'not-a-uuid'), await list(owner.token), await list(member.token)]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toMatchObject(NOT_FOUND_BODY);
    }
  });

  it('a guest is refused as before (below member), and the owner can still not declare, change or remove a gate', async () => {
    expect((await list(guest.token, ownedId)).statusCode).toBe(403);
    expect((await gate(ownedId, { operations: ['update'] }, owner.token)).statusCode).toBe(403);
    expect((await as(owner.token, 'PATCH', `/workspaces/${wsId}/agent-write-gates/${gateId}`, { enabled: false })).statusCode).toBe(403);
    expect((await as(owner.token, 'DELETE', `/workspaces/${wsId}/agent-write-gates/${gateId}`)).statusCode).toBe(403);
    expect((await db.query.agentWriteGates.findFirst({ where: eq(agentWriteGates.id, gateId) }))?.enabled).toBe(true);
  });

  it('an agent cannot read its own gates through its owner: the owner path refuses an agent-scoped token', async () => {
    const tok = await as(owner.token, 'POST', '/me/tokens', { name: 'owned bot token', workspace_id: wsId, scope: 'read', agent_id: ownedId });
    expect(tok.statusCode, tok.body).toBe(201);
    const res = await list(tok.json().token, ownedId);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('MUST KEEP: an admin reads one agent or all; an admin\'s read/write token still cannot (#1049), an admin-scoped one can', async () => {
    const all = await list(admin.token);
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().data.length).toBeGreaterThan(1);
    expect((await list(admin.token, ownedId)).json().data).toHaveLength(1);
    for (const scope of ['read', 'write']) {
      const tok = await as(admin.token, 'POST', '/me/tokens', { name: `admin ${scope}`, workspace_id: wsId, scope });
      expect((await list(tok.json().token, ownedId)).statusCode, scope).toBe(403);
    }
    const adminTok = await as(admin.token, 'POST', '/me/tokens', { name: 'admin admin', workspace_id: wsId, scope: 'admin' });
    expect((await list(adminTok.json().token)).statusCode).toBe(200);
    // the admin-owned agent's own admin-scoped token still sees its gates, as before (#1104)
    expect((await list(adminAgent.token, adminAgent.id)).statusCode).toBe(200);
  });
});

describe('#1104 a gated update is staged, approve applies exactly it, reject discards it', () => {
  let agent: { id: string; token: string };
  beforeAll(async () => {
    agent = await mkAgent('Hiring Bot');
    const g = await gate(agent.id, { operations: ['update'], database_id: candidatesId, fields: [stageApi] });
    expect(g.statusCode, g.body).toBe(201);
  });

  it('holds the update: 202 + approval id, record untouched, a pending approval for the agent owner', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Grace', [stageApi]: 'Applied' });
    const res = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Offer', [notesApi]: 'also this' } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ pending_approval: true });
    const after = await getRecord(candidatesId, rec.id);
    expect(after.values[stageApi]).toBe('Applied');
    expect(after.values[notesApi] ?? null).toBeNull();

    const rows = (await pendingFor(agent.id)).filter((r) => r.recordId === rec.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.id).toBe(res.json().approval_id);
    const snap = rows[0]!.actionSnapshot as { action: { inputs: unknown[]; operation: string }; ctx: { databaseId: string } };
    expect(snap.action.operation).toBe('update');
    expect(snap.action.inputs).toEqual([{ [stageApi]: 'Offer', [notesApi]: 'also this' }]);
    // It shows up where people look: the Approvals list.
    const listed = (await as(admin.token, 'GET', `/workspaces/${wsId}/approvals?status=pending`)).json() as Array<{ id: string; preview_text: string }>;
    expect(listed.find((a) => a.id === res.json().approval_id)?.preview_text).toContain('Hiring Bot wants to update a record in Candidates');
  });

  it('approve applies exactly the staged write, attributed to the agent; the agent cannot approve its own write', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Linus', [stageApi]: 'Applied' });
    const held = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Hired' } });
    const approvalId = held.json().approval_id as string;

    const selfApprove = await as(agent.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(selfApprove.statusCode, selfApprove.body).toBe(403);
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Applied');

    const ok = await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    await jobs.tick();
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Hired');
    // Provenance survives the approval detour: the change is the agent's, the actor is the person who owns it.
    const events = await as(admin.token, 'GET', `/workspaces/${wsId}/agents/${agent.id}/activity`);
    const change = (events.json().field_changes as Array<{ record_id: string; new_value: string }>).find((c) => c.record_id === rec.id);
    expect(change?.new_value).toBe('Hired');
    // Approving twice applies once: the second decision is an idempotent no-op, not a second write.
    await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    await jobs.tick();
    expect(await pendingFor(agent.id).then((r) => r.filter((x) => x.recordId === rec.id && x.status === 'pending'))).toHaveLength(0);
  });

  it('reject discards: the record never changes and nothing is enqueued', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Margaret', [stageApi]: 'Applied' });
    const held = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Rejected by agent' } });
    const approvalId = held.json().approval_id as string;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'no' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await jobs.tick();
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Applied');
    expect((await db.query.approvals.findFirst({ where: eq(approvals.id, approvalId) }))!.status).toBe('rejected');
  });

  it('approve RE-CHECKS: if the agent is gone by approval time the staged write is not applied', async () => {
    const doomed = await mkAgent('Doomed Bot');
    await gate(doomed.id, { operations: ['update'] });
    const rec = await mkRecord(candidatesId, { name: 'Ken', [stageApi]: 'Applied' });
    const held = await as(doomed.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Hired' } });
    expect(held.statusCode, held.body).toBe(202);
    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${agentsDbId}/records/${doomed.id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
    await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${held.json().approval_id}/approve`);
    await jobs.tick();
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Applied');
  });

  it('does NOT touch: an ungated field, another database, a person, an ungated agent, an automation-free human edit', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Alan', [stageApi]: 'Applied' });
    // A field the gate does not name: written straight through (the gate is narrowed to Stage).
    const ungatedField = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [notesApi]: 'just a note' } });
    expect(ungatedField.statusCode, ungatedField.body).toBe(200);
    expect((await getRecord(candidatesId, rec.id)).values[notesApi]).toBe('just a note');
    // Another database: the gate names Candidates only.
    const other = await mkRecord(otherDbId, { name: 'Elsewhere', [stageApi]: 'a' });
    const elsewhere = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${otherDbId}/records/${other.id}`, { values: { [stageApi]: 'b' } });
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    // A person editing the gated field.
    const human = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Screening' } });
    expect(human.statusCode, human.body).toBe(200);
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Screening');
    // A different agent with no gate.
    const free = await mkAgent('Free Bot');
    const freeRes = await as(free.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Interview' } });
    expect(freeRes.statusCode, freeRes.body).toBe(200);
    // Switching the gate off lets the gated agent through again (and says so: it is a declared, reversible gate).
    const gates = (await as(admin.token, 'GET', `/workspaces/${wsId}/agent-write-gates?agent_id=${agent.id}`)).json().data as Array<{ id: string }>;
    for (const g of gates) await as(admin.token, 'PATCH', `/workspaces/${wsId}/agent-write-gates/${g.id}`, { enabled: false });
    const off = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}`, { values: { [stageApi]: 'Offer' } });
    expect(off.statusCode, off.body).toBe(200);
    for (const g of gates) await as(admin.token, 'PATCH', `/workspaces/${wsId}/agent-write-gates/${g.id}`, { enabled: true });
  });

  it('a batch update by the gated agent holds each record rather than slipping past (reported in `held`)', async () => {
    const a = await mkRecord(candidatesId, { name: 'B1', [stageApi]: 'Applied' });
    const b = await mkRecord(candidatesId, { name: 'B2', [stageApi]: 'Applied' });
    const res = await as(agent.token, 'PATCH', `/workspaces/${wsId}/databases/${candidatesId}/records/batch`, { record_ids: [a.id, b.id], values: { [stageApi]: 'Hired' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBe(0);
    expect(res.json().held).toHaveLength(2);
    expect((await getRecord(candidatesId, a.id)).values[stageApi]).toBe('Applied');
    expect((await getRecord(candidatesId, b.id)).values[stageApi]).toBe('Applied');
  });

  it('a board drop (move with values) is an update: held, and the card does not even move; a plain reorder is not an update', async () => {
    const a = await mkRecord(candidatesId, { name: 'M1', [stageApi]: 'Applied' });
    const b = await mkRecord(candidatesId, { name: 'M2', [stageApi]: 'Applied' });
    const posBefore = (await getRecord(candidatesId, a.id) as unknown as { position: string }).position;
    const held = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/${a.id}/move`, { after_record_id: b.id, values: { [stageApi]: 'Hired' } });
    expect(held.statusCode, held.body).toBe(202);
    const after = (await getRecord(candidatesId, a.id)) as unknown as { position: string; values: Record<string, unknown> };
    expect(after.values[stageApi]).toBe('Applied');
    expect(after.position).toBe(posBefore);
    const reorder = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/${a.id}/move`, { after_record_id: b.id });
    expect(reorder.statusCode, reorder.body).toBe(201);
  });

  it('a button pressed by the gated agent cannot do what the agent may not: its record write is held', async () => {
    const btn = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/fields`, {
      display_name: 'Advance',
      type: 'button',
      config: { color: 'green', actions: [{ type: 'set_values', values: { [stageApi]: 'Via button' } }] },
    });
    expect(btn.statusCode, btn.body).toBe(201);
    const rec = await mkRecord(candidatesId, { name: 'Pressed', [stageApi]: 'Applied' });
    const press = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}/buttons/${btn.json().id}/press`);
    expect(press.statusCode, press.body).toBe(202);
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Applied');
    // A person pressing the same button is not held.
    const human = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}/buttons/${btn.json().id}/press`);
    expect(human.statusCode, human.body).toBeLessThan(300);
    expect((await getRecord(candidatesId, rec.id)).values[stageApi]).toBe('Via button');
  });

  it('changing relation links is refused for an update-gated agent, and allowed for an ungated one', async () => {
    const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
      database_a_id: candidatesId,
      database_b_id: otherDbId,
      cardinality: 'many_to_many',
      field_a_name: 'Related notes',
      field_b_name: 'Related candidates',
    });
    expect(rel.statusCode, rel.body).toBeLessThan(300);
    const fieldId = rel.json().field_a.id as string;
    const cand = await mkRecord(candidatesId, { name: 'Linker' });
    const note = await mkRecord(otherDbId, { name: 'A note' });
    const url = `/workspaces/${wsId}/databases/${candidatesId}/records/${cand.id}/links/${fieldId}`;
    expect((await as(agent.token, 'POST', url, { record_ids: [note.id] })).statusCode).toBe(422);
    const free = await mkAgent('Link Free Bot');
    expect((await as(free.token, 'POST', url, { record_ids: [note.id] })).statusCode).toBeLessThan(300);
  });

  it('a bulk UPDATE job is refused for an update-gated agent (the worker would write with no agent identity)', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Bulk', [stageApi]: 'Applied' });
    const job = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/batch-jobs`, { op: 'update', record_ids: [rec.id], values: { [stageApi]: 'Hired' } });
    expect(job.statusCode, job.body).toBe(422);
    const free = await mkAgent('Bulk Free Bot');
    const ok = await as(free.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/batch-jobs`, { op: 'update', record_ids: [rec.id], values: { [stageApi]: 'Hired' } });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
  });
});

describe('#1104 a gated create', () => {
  let agent: { id: string; token: string };
  beforeAll(async () => {
    agent = await mkAgent('Intake Bot');
    expect((await gate(agent.id, { operations: ['create'], database_id: candidatesId })).statusCode).toBe(201);
  });

  it('holds the create (nothing inserted); approve inserts exactly the staged record; reject inserts none', async () => {
    const before = await countRecords(candidatesId);
    const held = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records`, { values: { name: 'Staged Person', [notesApi]: 'n1' } });
    expect(held.statusCode, held.body).toBe(202);
    expect(await countRecords(candidatesId)).toBe(before);

    const ok = await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${held.json().approval_id}/approve`);
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    await jobs.tick();
    expect(await countRecords(candidatesId)).toBe(before + 1);
    const created = (await db.query.records.findMany({ where: eq(records.databaseId, candidatesId) })).find((r) => r.title === 'Staged Person');
    expect(created?.createdBy).toBeTruthy();
    expect((await getRecord(candidatesId, created!.id)).values[notesApi]).toBe('n1');

    const heldNo = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records`, { values: { name: 'Never Created' } });
    await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${heldNo.json().approval_id}/reject`, {});
    await jobs.tick();
    expect(await countRecords(candidatesId)).toBe(before + 1);
  });

  it('a batch create is ONE approval and creates all or none; an ungated database is unaffected', async () => {
    const before = await countRecords(candidatesId);
    const held = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/batch`, { records: [{ values: { name: 'P1' } }, { values: { name: 'P2' } }] });
    expect(held.statusCode, held.body).toBe(202);
    expect(await countRecords(candidatesId)).toBe(before);
    await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${held.json().approval_id}/approve`);
    await jobs.tick();
    expect(await countRecords(candidatesId)).toBe(before + 2);

    const free = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${otherDbId}/records`, { values: { name: 'Not gated here' } });
    expect(free.statusCode, free.body).toBe(201);
  });

  it('a duplicate (a create that cannot be shown as one write) is refused, not let through', async () => {
    const rec = await mkRecord(candidatesId, { name: 'Dup', [stageApi]: 'Applied' });
    const before = await countRecords(candidatesId);
    const dup = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records/${rec.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(422);
    expect(await countRecords(candidatesId)).toBe(before);
  });

  it('an invalid write is a 422 at once, not an approval that could never apply', async () => {
    const before = (await pendingFor(agent.id)).length;
    const bad = await as(agent.token, 'POST', `/workspaces/${wsId}/databases/${candidatesId}/records`, { values: { no_such_field: 'x' } });
    expect(bad.statusCode, bad.body).toBe(422);
    expect((await pendingFor(agent.id)).length).toBe(before);
  });
});

describe('#1104 the run executor goes through the same seam', () => {
  it('an agent RUN whose proposed set_values is gated is held (step says so, record unchanged), not failed', async () => {
    const agent = await mkAgent('Runner Bot');
    const agentFields = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${agentsDbId}`)).json().fields as Array<{ apiName: string; options?: Array<{ id: string; label: string }> }>;
    const writeScope = agentFields.find((f) => f.apiName === 'scopes')!.options!.find((o) => o.label === 'write')!.id;
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${agentsDbId}/records/${agent.id}`, { values: { scopes: [writeScope] } });
    await gate(agent.id, { operations: ['update'], database_id: candidatesId });
    const rec = await mkRecord(candidatesId, { name: 'Run target', [notesApi]: 'before' });
    const action: ProposedAction = {
      kind: 'set_values',
      summary: 'write the note',
      payload: { apply: 'automation_action', database_id: candidatesId, record_id: rec.id, action: { type: 'set_values', values: { [notesApi]: 'by the run' } } },
    };
    const runtime: AgentRuntime = {
      runClass: 'non_ai',
      async *execute() {
        yield { tool: 'propose', summary: action.summary, action };
      },
    };
    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    service.runtimeFor = () => runtime;
    try {
      const run = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(run.statusCode, run.body).toBe(201);
    } finally {
      service.runtimeFor = original;
    }
    expect((await getRecord(candidatesId, rec.id)).values[notesApi]).toBe('before');
    const rows = (await pendingFor(agent.id)).filter((r) => r.recordId === rec.id);
    expect(rows).toHaveLength(1);
    await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${rows[0]!.id}/approve`);
    await jobs.tick();
    expect((await getRecord(candidatesId, rec.id)).values[notesApi]).toBe('by the run');
  });
});

describe('#1104 a manifest declares gates: install creates them, export round-trips them', () => {
  const manifest = (gates: unknown) => ({
    format_version: 1,
    slug: 'gated-hiring',
    name: 'Gated hiring',
    version: '1.0.0',
    summary: 'A hiring pack whose agent proposes and a person approves',
    databases: [
      { action: 'create', name: 'Applicants', space: 'Hiring pack', fields: [{ name: 'Notes', type: 'text' }] },
    ],
    states: [{ database: 'Applicants', field: 'Stage', options: [{ label: 'New' }, { label: 'Screening' }] }],
    agents: [
      {
        name: 'Recruiter',
        goal: 'Move applicants through the stages.',
        scopes: ['write'],
        approval_policy: [],
        target_databases: ['Applicants'],
        ...(gates === undefined ? {} : { write_gates: gates }),
      },
    ],
    triggers: [{ agent: 'Recruiter', database: 'Applicants', state_field: 'Stage', state_option: 'Screening', human_gate: false }],
  });

  it('install creates the declared gate (names resolved to ids); the installed agent is then actually gated', async () => {
    const ws = (await as(admin.token, 'POST', '/workspaces', { name: `Pack gates ${Date.now()}` })).json().id as string;
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: manifest([{ operations: ['update'], database: 'Applicants', fields: ['Notes'] }]) });
    expect(res.statusCode, res.body).toBe(201);
    const rows = await db.query.agentWriteGates.findMany({ where: eq(agentWriteGates.workspaceId, ws) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operations).toEqual(['update']);
    expect(rows[0]!.fields).toEqual(['notes']);
    expect(rows[0]!.databaseId).toBeTruthy();

    // Round trip: export the installed pack and read the same gate back, by name.
    const exported = await as(admin.token, 'POST', `/workspaces/${ws}/packs/export`, { name: 'Gated hiring', slug: 'gated-hiring', version: '1.0.0', summary: 'x', database_ids: [rows[0]!.databaseId] });
    expect(exported.statusCode, exported.body).toBeLessThan(300);
    const agent = (exported.json().agents as Array<{ name: string; write_gates?: unknown }>).find((a) => a.name === 'Recruiter');
    expect(agent?.write_gates).toEqual([{ operations: ['update'], database: 'Applicants', fields: ['Notes'] }]);
  });

  it('key ABSENT installs no gate and exports no key; key present and [] installs none (explicit empty)', async () => {
    const ws1 = (await as(admin.token, 'POST', '/workspaces', { name: `Pack nogates ${Date.now()}` })).json().id as string;
    expect((await as(admin.token, 'POST', `/workspaces/${ws1}/packs/install`, { manifest: manifest(undefined) })).statusCode).toBe(201);
    expect(await db.query.agentWriteGates.findMany({ where: eq(agentWriteGates.workspaceId, ws1) })).toHaveLength(0);
    const ws2 = (await as(admin.token, 'POST', '/workspaces', { name: `Pack emptygates ${Date.now()}` })).json().id as string;
    expect((await as(admin.token, 'POST', `/workspaces/${ws2}/packs/install`, { manifest: manifest([]) })).statusCode).toBe(201);
    expect(await db.query.agentWriteGates.findMany({ where: eq(agentWriteGates.workspaceId, ws2) })).toHaveLength(0);
  });

  it('a gate naming a database the pack does not declare refuses the install up front (a gate is never dropped quietly)', async () => {
    const ws = (await as(admin.token, 'POST', '/workspaces', { name: `Pack badgate ${Date.now()}` })).json().id as string;
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: manifest([{ operations: ['update'], database: 'Nope' }]) });
    expect(res.statusCode, res.body).toBe(422);
    expect(await db.query.agentWriteGates.findMany({ where: eq(agentWriteGates.workspaceId, ws) })).toHaveLength(0);
  });
});
