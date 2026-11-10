import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import { CATCH_UP_MAX_PER_CLICK } from '../src/runners/agent-catch-up.service';

/**
 * ticket #1152 / ADR-0021 Q15 — the one-click catch-up. The bug it answers: records that were ALREADY in an agent's trigger state
 * before the trigger (or the agent) existed never get a wake, because wakes come from events. Real fixtures throughout: the
 * agent's OWNER (a member), another member, an admin, a guest, the agent's own run credential, a restricted database, real wake
 * rows. Every number asserted is compared with the wake rows themselves, not with the endpoint's own arithmetic.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let ticketsDbId: string;
let stateFieldId: string;
let stateApi: string;
let reviewId: string;
let todoId: string;
let doneId: string;
let historyId: string;
let nextFieldId: string;
let nextApi: string;
let admin: { token: string; email: string };
let owner: Person;
let other: Person;
let guest: Person;
let ownAiId: string;
const { pool } = connectTestDb();
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

async function mkAgent(name: string, opts: { aiMode?: boolean; enabled?: boolean } = {}): Promise<string> {
  const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
    values: { name, enabled: opts.enabled ?? true, ...(opts.aiMode === false ? {} : { ai_mode: ownAiId }) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mkTicket(name: string, values: Record<string, unknown> = {}): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name, ...values } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function bindState(agent: string, optionId: string, extra: Record<string, unknown> = {}) {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: ticketsDbId, state_field_id: stateFieldId, state_option_id: optionId, ...extra });
  expect(res.statusCode, res.body).toBe(201);
}
const wakeRows = async (agent: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agent])).rows;
const catchUp = (token: string | null, agent: string) => as(token, 'POST', `/workspaces/${ws}/agents/${agent}/catch-up`);
async function summaryFor(token: string, agent: string) {
  const res = await as(token, 'GET', `/workspaces/${ws}/agent-wakes/summary`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().agents as Array<{ agent_id: string; catch_up: number | null; waiting: number; can_run: boolean }>).find((a) => a.agent_id === agent);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'CatchAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Catch-up WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  ownAiId = opts.rows.find((r: { label: string }) => r.label === 'Your own AI').id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  const state = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'Status', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'Onboarding' }, { label: 'Done' }, { label: 'History' }] })).json();
  stateFieldId = state.id;
  stateApi = state.apiName;
  todoId = state.options.find((o: { label: string }) => o.label === 'Todo').id;
  reviewId = state.options.find((o: { label: string }) => o.label === 'Onboarding').id;
  historyId = state.options.find((o: { label: string }) => o.label === 'History').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;
  const rel = await as(admin.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: ticketsDbId, database_b_id: agentsDbId, cardinality: 'one_to_many', field_a_name: 'Next', field_b_name: 'Queue' });
  expect(rel.statusCode, rel.body).toBe(201);
  const detail = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}`)).json();
  const next = detail.fields.find((f: { displayName: string }) => f.displayName === 'Next');
  nextFieldId = next.id;
  nextApi = next.apiName;
  owner = await joinAs(app, admin.token, ws, 'CatchOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'CatchOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'CatchGuest', 'guest', [{ database_id: ticketsDbId, role: 'viewer' }, { database_id: agentsDbId, role: 'viewer' }]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('records already in the trigger state before the agent and its trigger existed', () => {
  it('PREMISE: they never get a wake on their own; the count says how many, and the click queues one per record', async () => {
    // The records come FIRST, then the agent, then the binding: exactly JCM's Acme Co.
    const a = await mkTicket('Acme', { [stateApi]: reviewId });
    const b = await mkTicket('Beta', { [stateApi]: reviewId });
    const c = await mkTicket('Cora', { [stateApi]: reviewId });
    await mkTicket('Elsewhere', { [stateApi]: doneId }); // not in the trigger state: never counted
    const gone = await mkTicket('Trashed', { [stateApi]: reviewId });
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${ticketsDbId}/records/${gone}`)).statusCode).toBe(200);
    const agent = await mkAgent('Onboarding Assistant');
    await bindState(agent, reviewId);
    expect(await wakeRows(agent)).toHaveLength(0); // the bug: nothing ever wakes it

    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(3);
    expect((await summaryFor(admin.token, agent))?.catch_up).toBe(3);
    expect((await summaryFor(other.token, agent))?.catch_up ?? null).toBeNull(); // not told: not the owner, not an admin
    expect((await summaryFor(guest.token, agent))?.catch_up ?? null).toBeNull();

    const res = await catchUp(owner.token, agent);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ queued: 3, already_waiting: 0, remaining: 0 });
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { record_id: string }) => r.record_id).sort()).toEqual([a, b, c].sort());
    for (const r of rows) expect(r).toMatchObject({ status: 'queued', reason: 'catch_up', requested_by: owner.id });
    expect(rows.every((r: { run_id: string | null }) => r.run_id)).toBe(true); // each has its Run record, like any other wake

    // An agent with NO Runner still gets queued wakes, and the summary still reads them as waiting.
    const sum = await summaryFor(owner.token, agent);
    expect(sum).toMatchObject({ waiting: 3, can_run: false, catch_up: 0 });

    // A second click adds nothing.
    const again = await catchUp(owner.token, agent);
    expect(again.json()).toMatchObject({ queued: 0, already_waiting: 3, remaining: 0 });
    expect(await wakeRows(agent)).toHaveLength(3);
  });

  it('zero is a real answer: an agent with no binding, and a binding with nothing in the state, both read 0 and queue nothing', async () => {
    const bare = await mkAgent('No binding');
    expect((await summaryFor(owner.token, bare))?.catch_up).toBe(0);
    expect((await catchUp(owner.token, bare)).json()).toMatchObject({ queued: 0, already_waiting: 0, remaining: 0 });
    expect(await wakeRows(bare)).toHaveLength(0);
  });

  it('a record with a wake that finished is handled; a failed or canceled one is not (it was never served)', async () => {
    const agent = await mkAgent('History bot');
    const t1 = await mkTicket('Ran', { [stateApi]: historyId });
    const t2 = await mkTicket('Failed', { [stateApi]: historyId });
    const t3 = await mkTicket('Canceled', { [stateApi]: historyId });
    const t4 = await mkTicket('Fresh', { [stateApi]: historyId });
    await bindState(agent, historyId);
    const dbId = ticketsDbId;
    for (const [rec, status] of [[t1, 'done'], [t2, 'failed'], [t3, 'canceled']] as const) {
      await pool.query(
        `insert into agent_wakes (workspace_id, agent_id, record_id, database_id, reason, status, finished_at) values ($1, $2, $3, $4, 'state_change', $5, now())`,
        [ws, agent, rec, dbId, status],
      );
    }
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(3);
    const res = await catchUp(owner.token, agent);
    expect(res.json()).toMatchObject({ queued: 3, remaining: 0 });
    const queued = (await wakeRows(agent)).filter((w: { status: string }) => w.status === 'queued').map((w: { record_id: string }) => w.record_id);
    expect(queued.sort()).toEqual([t2, t3, t4].sort()); // never the one that already ran
  });

  it('a click queues at most the cap and SAYS how many remain; the next click takes the rest', async () => {
    const agent = await mkAgent('Backlog bot');
    const total = CATCH_UP_MAX_PER_CLICK + 3;
    for (let i = 0; i < total; i++) await mkTicket(`Backlog ${i}`, { [stateApi]: todoId });
    await bindState(agent, todoId);
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(total);
    const first = await catchUp(owner.token, agent);
    expect(first.json()).toMatchObject({ queued: CATCH_UP_MAX_PER_CLICK, already_waiting: 0, remaining: 3 });
    expect(await wakeRows(agent)).toHaveLength(CATCH_UP_MAX_PER_CLICK);
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(3);
    const second = await catchUp(owner.token, agent);
    expect(second.json()).toMatchObject({ queued: 3, already_waiting: CATCH_UP_MAX_PER_CLICK, remaining: 0 });
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r: { record_id: string }) => r.record_id)).size).toBe(total); // one wake per record, none twice
  });

  it('a relation binding: records already linked to the agent are waiting too', async () => {
    const agent = await mkAgent('Relation bot');
    const t = await mkTicket('Linked first');
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${t}`, { values: { [nextApi]: [agent] } });
    await mkTicket('Not linked');
    const bound = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: ticketsDbId, relation_field_id: nextFieldId });
    expect(bound.statusCode, bound.body).toBe(201);
    expect(await wakeRows(agent)).toHaveLength(0);
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(1);
    expect((await catchUp(owner.token, agent)).json()).toMatchObject({ queued: 1, remaining: 0 });
    expect((await wakeRows(agent))[0]).toMatchObject({ record_id: t, reason: 'catch_up' });
  });

  it('a human-gated binding contributes nothing', async () => {
    const agent = await mkAgent('Gated bot');
    await mkTicket('Held', { [stateApi]: doneId });
    await bindState(agent, doneId, { human_gate: true });
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(0);
    expect((await catchUp(owner.token, agent)).json()).toMatchObject({ queued: 0, remaining: 0 });
    expect(await wakeRows(agent)).toHaveLength(0);
  });

  it('a record in a database the agent\'s owner cannot see is neither counted nor woken', async () => {
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const secret = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Secret clients' })).json().id as string;
    const st = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secret}/fields`, { display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'Open' }] })).json();
    const agent = await mkAgent('Nosy bot');
    for (const n of ['S1', 'S2']) {
      const r = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secret}/records`, { values: { name: n, [st.apiName]: st.options[0].id } });
      expect(r.statusCode, r.body).toBe(201);
    }
    const bound = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: secret, state_field_id: st.id, state_option_id: st.options[0].id });
    expect(bound.statusCode, bound.body).toBe(201);
    // Open to everyone first: the owner sees both.
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(2);
    await setRestricted(app, admin.token, ws, 'database', secret, true);
    expect((await summaryFor(owner.token, agent))?.catch_up).toBe(0);
    // An ADMIN pressing it is still bound by what the agent (its owner) can read.
    expect((await catchUp(admin.token, agent)).json()).toMatchObject({ queued: 0, remaining: 0 });
    expect(await wakeRows(agent)).toHaveLength(0);
  });
});

describe('who may press it', () => {
  it('another member and an unknown agent get the SAME 404; a guest gets 403; an admin may; the owner may', async () => {
    const agent = await mkAgent('Guarded bot');
    const t = await mkTicket('Guarded ticket', { [stateApi]: reviewId });
    await bindState(agent, reviewId);
    const stranger = await catchUp(other.token, agent);
    const nobody = await catchUp(other.token, '00000000-0000-4000-8000-000000000000');
    expect(stranger.statusCode).toBe(404);
    expect(nobody.statusCode).toBe(404);
    expect(stranger.json().message).toBe(nobody.json().message);
    expect((await catchUp(guest.token, agent)).statusCode).toBe(403);
    expect((await catchUp(null, agent)).statusCode).toBe(401);
    expect(await wakeRows(agent)).toHaveLength(0);
    const byAdmin = await catchUp(admin.token, agent);
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json().queued).toBeGreaterThanOrEqual(1);
    expect((await wakeRows(agent)).some((w: { record_id: string }) => w.record_id === t)).toBe(true);
  });

  it('a switched-off agent and a non-own-AI agent are refused in words', async () => {
    const off = await mkAgent('Off bot', { enabled: false });
    const managed = await mkAgent('Managed bot', { aiMode: false });
    expect((await catchUp(owner.token, off)).statusCode).toBe(422);
    expect((await catchUp(owner.token, managed)).statusCode).toBe(422);
  });

  it("the agent's own per-run credential is refused (an agent cannot start itself on a backlog)", async () => {
    const w = await buildRunCredentialWorld(app, pool, 'CatchCred');
    const res = await call(app, w.credential, 'POST', `/workspaces/${w.ws}/agents/${w.agentId}/catch-up`);
    expect(res.statusCode, res.body).toBe(403);
    // and the person it works for can still do it
    const ok = await call(app, w.owner.token, 'POST', `/workspaces/${w.ws}/agents/${w.agentId}/catch-up`);
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

/** ticket #1224 — the list behind the count: names, not just a number. Own database so earlier tests' records are not in play. */
const listWaiting = (token: string | null, agent: string, qs = '') => as(token, 'GET', `/workspaces/${ws}/agents/${agent}/catch-up${qs}`);

describe('ticket #1224: catch-up names the waiting records', () => {
  let nDb: string;
  let nField: string;
  let nApi: string;
  let nA: string;
  let nB: string;
  let nC: string;
  const mkN = async (name: string, option: string) => {
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${nDb}/records`, { values: { name, [nApi]: option } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const bindN = async (agent: string, option: string) => {
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: nDb, state_field_id: nField, state_option_id: option });
    expect(res.statusCode, res.body).toBe(201);
  };

  beforeAll(async () => {
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    nDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Names DB' })).json().id;
    const st = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${nDb}/fields`, { display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] })).json();
    nField = st.id;
    nApi = st.apiName;
    nA = st.options.find((o: { label: string }) => o.label === 'A').id;
    nB = st.options.find((o: { label: string }) => o.label === 'B').id;
    nC = st.options.find((o: { label: string }) => o.label === 'C').id;
  });

  it('the list endpoint returns exactly the records the count counts (the count equals the list total, and the ids match the wakes a click makes)', async () => {
    const agent = await mkAgent('Names bot');
    const ids = [await mkN('Acme Co (sample)', nA), await mkN('Bright', nA), await mkN('Cobalt', nA)];
    await mkN('Not in the state', nC);
    await bindN(agent, nA);
    const count = (await summaryFor(owner.token, agent))?.catch_up;
    const res = await listWaiting(owner.token, agent, '?limit=100');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(count).toBe(3);
    expect(body.total).toBe(count);
    expect(body.listed_total).toBe(count);
    expect(body.not_listed).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(['Acme Co (sample)', 'Bright', 'Cobalt']); // oldest first
    expect(body.items[0]).toMatchObject({ id: ids[0], database_id: nDb, database_name: 'Names DB' });
    await catchUp(owner.token, agent);
    const woken = (await wakeRows(agent)).map((r: { record_id: string }) => r.record_id).sort();
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual(woken);
    // once queued they are no longer waiting: the list empties with the count
    expect((await listWaiting(owner.token, agent)).json()).toMatchObject({ total: 0, listed_total: 0, items: [], truncated: false });
  });

  it('a capped page says so: truncated true with the real total, and offset pages through to the end with no repeat or gap', async () => {
    const agent = await mkAgent('Paging bot');
    for (let i = 0; i < 7; i++) await mkN(`Page ${i}`, nB);
    await bindN(agent, nB);
    const total = (await summaryFor(owner.token, agent))?.catch_up as number;
    expect(total).toBe(7);
    const first = (await listWaiting(owner.token, agent, '?limit=5')).json();
    expect(first).toMatchObject({ total: 7, limit: 5, offset: 0, truncated: true });
    expect(first.items).toHaveLength(5);
    const second = (await listWaiting(owner.token, agent, '?limit=5&offset=5')).json();
    expect(second).toMatchObject({ total: 7, offset: 5, truncated: false });
    const seen = [...first.items, ...second.items].map((i: { title: string }) => i.title);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `Page ${i}`));
  });

  it('the default page is 5 and a bad limit is a 422, not a silent clamp', async () => {
    const agent = await mkAgent('Limit bot');
    await bindN(agent, nB);
    expect((await listWaiting(owner.token, agent)).json().items).toHaveLength(5);
    expect((await listWaiting(owner.token, agent, '?limit=0')).statusCode).toBe(422);
    expect((await listWaiting(owner.token, agent, '?limit=101')).statusCode).toBe(422);
  });

  it('access matches the summary: the owner and an admin read it; another member gets the same 404 as an unknown agent; a guest gets 403; no token 401', async () => {
    const agent = await mkAgent('Names guarded bot');
    await bindN(agent, nB);
    expect((await listWaiting(owner.token, agent)).statusCode).toBe(200);
    const byAdmin = await listWaiting(admin.token, agent);
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().total).toBe((await summaryFor(admin.token, agent))?.catch_up);
    const stranger = await listWaiting(other.token, agent);
    const nobody = await listWaiting(other.token, '00000000-0000-4000-8000-000000000000');
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json().message).toBe(nobody.json().message);
    expect((await listWaiting(guest.token, agent)).statusCode).toBe(403);
    expect((await listWaiting(null, agent)).statusCode).toBe(401);
  });

  it('a record in a database the owner cannot open is not named, and not counted either', async () => {
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const secret = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Hidden names' })).json().id as string;
    const st = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secret}/fields`, { display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'Open' }] })).json();
    const agent = await mkAgent('Names nosy bot');
    const r = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secret}/records`, { values: { name: 'Confidential Corp', [st.apiName]: st.options[0].id } });
    expect(r.statusCode, r.body).toBe(201);
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: secret, state_field_id: st.id, state_option_id: st.options[0].id });
    expect((await listWaiting(owner.token, agent)).json().items.map((i: { title: string }) => i.title)).toEqual(['Confidential Corp']);
    await setRestricted(app, admin.token, ws, 'database', secret, true);
    for (const who of [owner, admin]) {
      const res = await listWaiting(who.token, agent);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ total: 0, listed_total: 0, items: [] });
      expect(res.body).not.toContain('Confidential Corp');
    }
  });

  it('an agent that cannot take wakes (switched off) lists nothing with total 0, like its null count', async () => {
    const off = await mkAgent('Names off bot', { enabled: false });
    expect((await listWaiting(owner.token, off)).json()).toMatchObject({ total: 0, items: [], truncated: false });
  });
});
