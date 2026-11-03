import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';

/**
 * ticket #1139 AC6 — setting an agent through the record's RELATION EDITOR (PUT .../links/:field, a whole-set replace) must wake it
 * exactly like the inline write and the POST/MCP link do. The replace used to emit `record_linked` with NO `linkDirection`, which the
 * wake source ignores (it only fires on 'link'), so the agent was never woken from the editor.
 *
 * A replace is a SET operation: only the NEWLY added ids wake, a removed id never wakes, and re-saving the same set wakes nothing.
 * Fixtures: an admin, the agents' owner (a member), a guest who reads Tickets but has no grant on Agents, and a guest who reads both
 * (CLAUDE.md: only guests have partial access, so a test without one proves nothing).
 */
let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let ws: string;
let agentsDbId: string;
let ticketsDbId: string;
let teamFieldId: string;
let admin: { token: string; email: string };
let owner: Person;
let guestPartial: Person;
let guestFull: Person;
let aiModeId: string;
const { pool } = connectTestDb();
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

const wakeRows = async (agentId: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agentId])).rows;
const total = async (...agents: string[]) => (await Promise.all(agents.map(wakeRows))).reduce((n, r) => n + r.length, 0);
const coalesced = async (agentId: string) => (await wakeRows(agentId)).reduce((n: number, r: { coalesced_count: number }) => n + r.coalesced_count, 0);

async function mkAgent(name: string): Promise<string> {
  const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true, ai_mode: aiModeId } });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  const b = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent: id, database_id: ticketsDbId, relation_field_id: teamFieldId });
  expect(b.statusCode, b.body).toBe(201);
  return id;
}
async function mkTicket(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const linksUrl = (rec: string) => `/workspaces/${ws}/databases/${ticketsDbId}/records/${rec}/links/${teamFieldId}`;
async function put(token: string, rec: string, ids: string[]) {
  const res = await as(token, 'PUT', linksUrl(rec), { record_ids: ids });
  await subscriber.settle(rec);
  return res;
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'EditorWakeAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Editor wake WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  aiModeId = opts.rows.find((r: { label: string }) => r.label === 'Your own AI').id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  const rel = await as(admin.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: ticketsDbId, database_b_id: agentsDbId, cardinality: 'many_to_many', field_a_name: 'Team', field_b_name: 'Tickets' });
  expect(rel.statusCode, rel.body).toBe(201);
  const detail = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}`)).json();
  teamFieldId = detail.fields.find((f: { displayName: string }) => f.displayName === 'Team').id;
  owner = await joinAs(app, admin.token, ws, 'EditorOwner', 'member');
  guestPartial = await joinAs(app, admin.token, ws, 'EditorGuestA', 'guest', [{ database_id: ticketsDbId, role: 'editor' }]);
  guestFull = await joinAs(app, admin.token, ws, 'EditorGuestB', 'guest', [{ database_id: ticketsDbId, role: 'editor' }, { database_id: agentsDbId, role: 'viewer' }]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the relation editor (PUT links) wakes an agent exactly once, and only for a NEW link (ticket #1139 AC6)', () => {
  it('replacing [] with [A] creates exactly one queued wake for A, reason assigned, on that record', async () => {
    const a = await mkAgent('Editor A');
    const ticket = await mkTicket('Editor ticket 1');
    expect((await put(admin.token, ticket, [a])).statusCode).toBe(200);
    const rows = await wakeRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'assigned', record_id: ticket });
  });

  it('[A] -> [A, B] wakes B only; A is not woken again (no new row, no coalesce)', async () => {
    const a = await mkAgent('Editor A2');
    const b = await mkAgent('Editor B2');
    const ticket = await mkTicket('Editor ticket 2');
    await put(admin.token, ticket, [a]);
    const aCoalesced = await coalesced(a);
    expect((await put(admin.token, ticket, [a, b])).statusCode).toBe(200);
    expect(await wakeRows(a)).toHaveLength(1);
    expect(await coalesced(a)).toBe(aCoalesced);
    const rowsB = await wakeRows(b);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ status: 'queued', reason: 'assigned', record_id: ticket });
  });

  it('[A, B] -> [B] wakes nothing: an unlink never wakes, and B (kept) is not woken again', async () => {
    const a = await mkAgent('Editor A3');
    const b = await mkAgent('Editor B3');
    const ticket = await mkTicket('Editor ticket 3');
    await put(admin.token, ticket, [a, b]);
    const before = { total: await total(a, b), bCoalesced: await coalesced(b), aCoalesced: await coalesced(a) };
    expect((await put(admin.token, ticket, [b])).statusCode).toBe(200);
    expect(await total(a, b)).toBe(before.total);
    expect(await coalesced(b)).toBe(before.bCoalesced);
    expect(await coalesced(a)).toBe(before.aCoalesced);
  });

  it('saving the same set again wakes nothing (even after the first wake has gone from the queue)', async () => {
    const a = await mkAgent('Editor A4');
    const ticket = await mkTicket('Editor ticket 4');
    await put(admin.token, ticket, [a]);
    const first = await coalesced(a);
    expect((await put(admin.token, ticket, [a])).statusCode).toBe(200);
    expect(await wakeRows(a)).toHaveLength(1);
    expect(await coalesced(a)).toBe(first);
    // The wake is finished: a re-save is STILL not a link, so it must not start a second one.
    await pool.query("update agent_wakes set status = 'done' where agent_id = $1", [a]);
    expect((await put(admin.token, ticket, [a])).statusCode).toBe(200);
    expect(await wakeRows(a)).toHaveLength(1);
  });

  it('removing an agent and adding it back IS a new link and wakes it', async () => {
    const a = await mkAgent('Editor A5');
    const ticket = await mkTicket('Editor ticket 5');
    await put(admin.token, ticket, [a]);
    await pool.query("update agent_wakes set status = 'done' where agent_id = $1", [a]);
    await put(admin.token, ticket, []);
    expect(await wakeRows(a)).toHaveLength(1);
    await put(admin.token, ticket, [a]);
    expect((await wakeRows(a)).filter((w: { status: string }) => w.status === 'queued')).toHaveLength(1);
  });

  it('regression: the POST link path still creates exactly one wake, and a repeat coalesces', async () => {
    const a = await mkAgent('Editor A6');
    const ticket = await mkTicket('Editor ticket 6');
    const res = await as(admin.token, 'POST', linksUrl(ticket), { record_ids: [a] });
    expect(res.statusCode, res.body).toBe(201);
    await subscriber.settle(ticket);
    const rows = await wakeRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'assigned', record_id: ticket });
    await as(admin.token, 'POST', linksUrl(ticket), { record_ids: [a] });
    await subscriber.settle(ticket);
    expect(await wakeRows(a)).toHaveLength(1);
  });

  it('access: a guest who cannot see the Agents database wakes nothing; a guest who can see both wakes it, authored by them', async () => {
    const a = await mkAgent('Editor A7');
    const ticket = await mkTicket('Editor ticket 7');
    const denied = await put(guestPartial.token, ticket, [a]);
    expect(denied.statusCode, denied.body).not.toBe(200);
    expect(await wakeRows(a)).toHaveLength(0);
    const allowed = await put(guestFull.token, ticket, [a]);
    expect(allowed.statusCode, allowed.body).toBe(200);
    const rows = await wakeRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by).toBe(guestFull.id);
  });

  it('duplicating a record that has an agent linked is a pure link on the copy: it carries a direction, so the copy is woken once', async () => {
    const a = await mkAgent('Editor A8');
    const ticket = await mkTicket('Editor ticket 8');
    await put(admin.token, ticket, [a]);
    const dup = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const copyId = dup.json().id as string;
    await subscriber.settle(copyId);
    const forCopy = (await wakeRows(a)).filter((w: { record_id: string }) => w.record_id === copyId);
    expect(forCopy).toHaveLength(1);
    expect(forCopy[0]).toMatchObject({ status: 'queued', reason: 'assigned' });
  });
});
