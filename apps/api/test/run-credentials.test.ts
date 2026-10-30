import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentWakesService } from '../src/runners/agent-wakes.service';
import { RunnerSweeperService } from '../src/runners/runner-sweeper.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { WAKE_MAX_DEPTH } from '../src/runners/wake.constants';

/**
 * #1132 / ADR-0021 §4 — the per-run credential. Real fixtures for every kind of person the rules name: a MEMBER who owns the agents
 * and a Runner, an ADMIN (whose own agent declares `admin` and must still be capped), ANOTHER member, and a GUEST. Every claim below
 * is the real thing: a Runner pairs, a wake is claimed over HTTP, the credential in the claim response is used as a bearer token on
 * the ordinary workspace routes (the same ones the MCP server calls), and the rows are read back out of the audit tables.
 */
let app: NestFastifyApplication;
let wakes: AgentWakesService;
let sweeper: RunnerSweeperService;
let jobs: JobRunnerService;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let notesApi: string;
let admin: { token: string; email: string };
let owner: Person; // a MEMBER: owns the agents and a Runner
let other: Person; // another member
let guest: Person;
let runner: { token: string; id: string };
let scopeIds: Record<string, string> = {};
let aiOwn = '';
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const MACHINE = "Ievgen's MacBook";
const report = () => ({ machine_name: MACHINE, tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const wakesOf = (res: { statusCode: number; body: string; json: () => unknown }): Claimed[] => (res.statusCode === 200 ? ((res.json() as { wakes?: Claimed[] }).wakes ?? []) : []);
const claim = (token: string, body: Record<string, unknown> = {}) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0, ...body });
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const agentMention = (id: string) => ({ type: 'mention', props: { kind: 'agent', id, label: 'agent' } });
const txt = (text: string) => ({ type: 'text', text, styles: {} });
const commentOn = (token: string, recordId: string, doc: unknown[]) =>
  as(token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${recordId}/comments`, { body: { format: 'blocknote', doc } });

async function mkAgent(who: { token: string }, name: string, scopes: string[] | null = ['write']): Promise<string> {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
    values: { name, enabled: true, ai_mode: aiOwn, ...(scopes ? { scopes: scopes.map((s) => scopeIds[s]) } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function mkTicket(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name, [notesApi]: 'start' } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function pairRunner(who: Person, agentIds: string[]) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(who.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  for (const agent of agentIds) {
    expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
  }
  return { token, id: r.id };
}

type Claimed = { id: string; nonce: string; depth: number; run_id: string | null; credential: { token: string; scope: string; expires_at: string } };

/** Delegates a fresh wake to `agent` for a new ticket and claims it with the Runner. */
async function claimFor(agent: string, runnerToken = runner.token): Promise<Claimed & { ticket: string }> {
  const ticket = await mkTicket(`Ticket for ${agent.slice(0, 4)}`);
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket });
  expect(res.statusCode, res.body).toBe(201);
  const got = await claim(runnerToken);
  expect(got.statusCode, got.body).toBe(200);
  const wake = wakesOf(got).find(Boolean);
  expect(wake, got.body).toBeTruthy();
  return { ...(wake as Claimed), ticket };
}

const tokenRow = async (token: string) => (await pool.query('select * from api_tokens where token_hash = $1', [sha256(token)])).rows[0];
const patchTicket = (token: string, ticket: string, value: string) =>
  as(token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [notesApi]: value } });
const complete = (w: Claimed, exit = 'ok') => asRunner(runner.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: w.nonce, exit });

beforeAll(async () => {
  app = await createTestApp();
  wakes = app.get(AgentWakesService);
  sweeper = app.get(RunnerSweeperService);
  jobs = app.get(JobRunnerService);
  admin = await signUpUser(app, 'RunCredAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Run credential WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  notesApi = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json().apiName;
  owner = await joinAs(app, admin.token, ws, 'RunCredOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'RunCredOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'RunCredGuest', 'guest', [{ database_id: ticketsDbId, role: 'contributor' }]);
  runner = await pairRunner(owner, []);
}, 180_000);

beforeEach(async () => {
  await pool.query('delete from runner_pairing_failures');
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
  await pool.query('update api_tokens set revoked_at = now() where workspace_id = $1 and runner_id is not null and revoked_at is null', [ws]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function assign(agent: string, r = runner) {
  expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
}

describe('the credential is minted at claim, by the server, and is the agent token extended', () => {
  it('is returned once in the claim response, stored only as a hash, bound to (agent, run, Runner, wake, depth) and capped at write', async () => {
    const agent = await mkAgent(owner, 'Minted bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect(w.credential.token).toMatch(/^mn_pat_/);
    expect(w.credential.scope).toBe('write');
    expect(new Date(w.credential.expires_at).getTime() - Date.now()).toBeGreaterThan(60_000);
    const row = await tokenRow(w.credential.token);
    expect(row).toMatchObject({ origin: 'agent', agent_id: agent, run_id: w.run_id, runner_id: runner.id, wake_id: w.id, run_depth: 0, user_id: owner.id, scope: 'write' });
    expect(row.token_hash).not.toBe(w.credential.token); // never the plaintext
    expect(JSON.stringify(row)).not.toContain(w.credential.token);
    expect(new Date(row.expires_at).getTime()).toBe(new Date(w.credential.expires_at).getTime());
  });

  it('scope = min(owner role, what the agent declares, write): an agent declaring nothing is read-only, and read cannot write', async () => {
    const silent = await mkAgent(owner, 'Silent bot', null);
    await assign(silent);
    const w = await claimFor(silent);
    expect(w.credential.scope).toBe('read');
    expect((await patchTicket(w.credential.token, w.ticket, 'nope')).statusCode).toBe(403);
    expect((await as(w.credential.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`)).statusCode).toBe(200);
  });

  it('CAP: an agent owned by an ADMIN that declares admin gets write, and every admin route is refused', async () => {
    const adminAgent = await mkAgent(admin, 'Admin-owned bot', ['admin']);
    const adminRunner = await pairRunner({ ...admin, id: '' } as unknown as Person, [adminAgent]);
    const w = await claimFor(adminAgent, adminRunner.token);
    expect(w.credential.scope).toBe('write');
    expect((await as(w.credential.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Not allowed' })).statusCode).toBe(403);
    expect((await as(w.credential.token, 'POST', `/workspaces/${ws}/invites`, { email: 'nobody@example.com', role: 'member' })).statusCode).toBe(403);
    // ...whereas the admin's own ordinary agent token (the pre-#1132 kind, minted by a person) keeps its declared admin scope.
    const legacy = await as(admin.token, 'POST', '/me/tokens', { name: 'legacy agent token', workspace_id: ws, scope: 'admin', agent_id: adminAgent });
    expect(legacy.statusCode, legacy.body).toBe(201);
    const lr = await as(legacy.json().token, 'GET', `/workspaces/${ws}/spaces`);
    expect(lr.statusCode, lr.body).toBe(200);
  });

  it('a GUEST-owned agent never gets one: the claim hands nothing out and the wake stays queued', async () => {
    const agent = await mkAgent(owner, 'Guest-owned bot');
    await assign(agent);
    await pool.query('update records set created_by = $1 where id = $2', [guest.id, agent]);
    const ticket = await mkTicket('Guest wake');
    const queued = await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: ticket, requestedBy: owner.id, materialize: true });
    expect(queued.outcome).toBe('created');
    const res = await claim(runner.token);
    expect(wakesOf(res)).toHaveLength(0);
    expect((await pool.query("select status from agent_wakes where agent_id = $1", [agent])).rows[0].status).toBe('queued');
    expect((await pool.query('select count(*)::int as n from api_tokens where agent_id = $1 and runner_id is not null', [agent])).rows[0].n).toBe(0);
  });

  it('a person cannot mint one: POST /me/tokens ignores run fields, and a run credential cannot mint or revoke tokens at all', async () => {
    const agent = await mkAgent(owner, 'Mint bot');
    await assign(agent);
    const w = await claimFor(agent);
    const forged = await as(owner.token, 'POST', '/me/tokens', { name: 'forged', workspace_id: ws, scope: 'write', agent_id: agent, run_id: w.run_id, runner_id: runner.id, wake_id: w.id, expires_at: '2099-01-01' });
    expect(forged.statusCode, forged.body).toBe(201);
    expect(await tokenRow(forged.json().token)).toMatchObject({ runner_id: null, run_id: null, wake_id: null, expires_at: null });
    // The credential used as a PAT for token management: refused (token management is session-only).
    expect((await as(w.credential.token, 'POST', '/me/tokens', { name: 'minted by a run', workspace_id: ws, scope: 'write' })).statusCode).toBe(403);
    expect((await as(w.credential.token, 'GET', '/me/tokens')).statusCode).toBe(403);
    expect((await as(w.credential.token, 'DELETE', `/me/tokens/${forged.json().id}`)).statusCode).toBe(403);
  });
});

describe('AC4 / "my tokens": a run credential is never listed, counted, or revocable as a personal token', () => {
  it('is absent from /me/tokens and /me/ai-connections, does not move the AI-connected count, and DELETE /me/tokens/:id is a 404 that leaves it working', async () => {
    const agent = await mkAgent(owner, 'Hidden bot');
    await assign(agent);
    const pat = await as(owner.token, 'POST', '/me/tokens', { name: 'my own PAT', workspace_id: ws, scope: 'write' });
    expect(pat.statusCode).toBe(201);
    const before = (await as(owner.token, 'GET', `/me/ai-connections?workspace_id=${ws}`)).json().data.length;
    const w = await claimFor(agent);
    const row = await tokenRow(w.credential.token);
    const list = (await as(owner.token, 'GET', '/me/tokens')).json().data as Array<{ id: string; name: string }>;
    expect(list.map((t) => t.id)).not.toContain(row.id);
    expect(list.map((t) => t.name)).toContain('my own PAT');
    const conns = (await as(owner.token, 'GET', `/me/ai-connections?workspace_id=${ws}`)).json().data as Array<{ id: string }>;
    expect(conns).toHaveLength(before);
    expect(conns.map((c) => c.id).join()).not.toContain(row.id);
    expect((await as(owner.token, 'DELETE', `/me/tokens/${row.id}`)).statusCode).toBe(404);
    expect((await as(owner.token, 'DELETE', `/me/ai-connections/token:${row.id}`)).statusCode).toBe(404);
    expect((await patchTicket(w.credential.token, w.ticket, 'still works')).statusCode).toBe(200);
  });

  it('MUST KEEP WORKING: a PAT, an existing agent token and the session behave exactly as before, and are listed', async () => {
    const agent = await mkAgent(owner, 'Legacy bot');
    const ticket = await mkTicket('Legacy ticket');
    const pat = await as(owner.token, 'POST', '/me/tokens', { name: 'plain PAT', workspace_id: ws, scope: 'write' });
    const legacy = await as(owner.token, 'POST', '/me/tokens', { name: 'plain agent token', workspace_id: ws, scope: 'write', agent_id: agent });
    for (const t of [pat.json().token, legacy.json().token]) expect((await patchTicket(t, ticket, `by ${t.slice(0, 12)}`)).statusCode).toBe(200);
    const ids = ((await as(owner.token, 'GET', '/me/tokens')).json().data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([pat.json().id, legacy.json().id]));
    // An existing agent token has NO run behind it: its rows carry the agent and nothing else.
    const ev = (await pool.query("select agent_id, run_id, runner_id, runner_name from activity_events where record_id = $1 and token_id = $2 order by created_at desc limit 1", [ticket, legacy.json().id])).rows[0];
    expect(ev).toMatchObject({ agent_id: agent, run_id: null, runner_id: null, runner_name: null });
    expect((await as(owner.token, 'DELETE', `/me/tokens/${pat.json().id}`)).statusCode).toBe(200);
    expect((await patchTicket(pat.json().token, ticket, 'revoked')).statusCode).toBe(401);
  });
});

describe('AC1: a write made with a run credential is attributed to the agent, the run and the Runner', () => {
  it('stamps activity_events, record_versions, record_field_changes and comments; the actor stays the owner, source = agent', async () => {
    const agent = await mkAgent(owner, 'Sales assistant');
    await assign(agent);
    const w = await claimFor(agent);
    const upd = await patchTicket(w.credential.token, w.ticket, 'written by the run');
    expect(upd.statusCode, upd.body).toBe(200);
    const created = await as(w.credential.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: 'Made by the run' } });
    expect(created.statusCode, created.body).toBe(201);
    const com = await commentOn(w.credential.token, w.ticket, [para(txt('on it'))]);
    expect(com.statusCode, com.body).toBe(201);
    expect(com.json()).toMatchObject({ source: 'agent', agent_id: agent, agent_name: 'Sales assistant' });

    const want = { source: 'agent', agent_id: agent, agent_name: 'Sales assistant', run_id: w.run_id, runner_id: runner.id, runner_name: MACHINE };
    const ev = (await pool.query("select * from activity_events where record_id = $1 and type = 'record.updated'", [w.ticket])).rows;
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev.filter((r: { run_id: string | null }) => r.run_id)) {
      expect(e).toMatchObject({ ...want, actor_id: owner.id });
    }
    expect(ev.some((e: { run_id: string | null }) => e.run_id === w.run_id)).toBe(true);
    for (const table of ['record_versions', 'record_field_changes']) {
      const rows = (await pool.query(`select * from ${table} where record_id = $1 and run_id is not null`, [w.ticket])).rows;
      expect(rows.length, table).toBeGreaterThan(0);
      expect(rows[0], table).toMatchObject(want);
    }
    const newRec = (await pool.query("select * from activity_events where record_id = $1 and type = 'record.created'", [created.json().id])).rows[0];
    expect(newRec).toMatchObject({ ...want, actor_id: owner.id });
    expect((await pool.query('select * from comments where id = $1', [com.json().id])).rows[0]).toMatchObject({ ...want, author_id: owner.id });
    const cEv = (await pool.query("select * from activity_events where type = 'comment.created' and record_id = $1 and payload->>'comment_id' = $2", [w.ticket, com.json().id])).rows[0];
    expect(cEv).toMatchObject(want);
    // The attribution is the credential's, not the caller's: a forged header or body field names no other run.
    const forged = await as(w.credential.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`, { values: { [notesApi]: 'forged', run_id: '11111111-1111-4111-8111-111111111111' } });
    expect(forged.statusCode).toBeLessThan(500);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`, headers: { ...authed(w.credential.token), 'x-run-id': '22222222-2222-4222-8222-222222222222', 'x-runner-id': '33333333-3333-4333-8333-333333333333' }, payload: { values: { [notesApi]: 'forged header' } } });
    expect(res.statusCode).toBe(200);
    const forgedRows = (await pool.query("select run_id, runner_id from record_field_changes where record_id = $1 and run_id is not null", [w.ticket])).rows;
    expect(forgedRows.every((r: { run_id: string; runner_id: string }) => r.run_id === w.run_id && r.runner_id === runner.id)).toBe(true);
  });

  it('a write through a different route (a record\'s document) is stamped too, and a person\'s own write carries no run', async () => {
    const agent = await mkAgent(owner, 'Doc writer');
    await assign(agent);
    const w = await claimFor(agent);
    const put = await as(w.credential.token, 'PUT', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}/document`, { content: [para(txt('notes from the run'))], expected_version: 0 });
    expect(put.statusCode, put.body).toBeLessThan(300);
    const docEv = (await pool.query("select * from activity_events where record_id = $1 and run_id = $2 and type <> 'record.updated'", [w.ticket, w.run_id])).rows;
    expect(docEv.length).toBeGreaterThan(0);
    expect(docEv[0]).toMatchObject({ agent_id: agent, runner_name: MACHINE, source: 'agent' });
    // A person at the keyboard: no run, no Runner.
    expect((await patchTicket(owner.token, w.ticket, 'by a person')).statusCode).toBe(200);
    const mine = (await pool.query("select run_id, runner_id, runner_name, source from activity_events where record_id = $1 and actor_id = $2 and type = 'record.updated' order by created_at desc limit 1", [w.ticket, owner.id])).rows[0];
    expect(mine).toMatchObject({ run_id: null, runner_id: null, runner_name: null, source: 'human' });
  });

  it('the audit log reads "agent, run N, on the Runner\'s machine" for an admin, and shows the same for the record history', async () => {
    const agent = await mkAgent(owner, 'Audit bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await patchTicket(w.credential.token, w.ticket, 'audited')).statusCode).toBe(200);
    const runNumber = (await pool.query('select number from records where id = $1', [w.run_id])).rows[0].number as number;
    expect(runNumber).toBeGreaterThan(0);
    const log = (await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100`)).json().data as Array<Record<string, unknown>>;
    const mine = log.filter((r) => r.run_id === w.run_id);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      expect(row).toMatchObject({ source: 'agent', agent_id: agent, agent_name: 'Audit bot', runner_id: runner.id, runner_name: MACHINE, run_number: runNumber, actor_id: owner.id });
    }
    expect(mine.some((r) => r.kind === 'field_change')).toBe(true);
    // A row nobody's run made has no run number.
    expect(log.filter((r) => !r.run_id).every((r) => r.run_number === null)).toBe(true);
    const versions = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}/versions`)).json().data as Array<Record<string, unknown>>;
    expect(versions.find((v) => v.run_id === w.run_id)).toMatchObject({ agent_name: 'Audit bot', runner_name: MACHINE });
  });

  it('the Runner\'s name is a snapshot: renaming or removing the Runner later does not rewrite what the history says', async () => {
    const agent = await mkAgent(owner, 'Snapshot bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await patchTicket(w.credential.token, w.ticket, 'before rename')).statusCode).toBe(200);
    await pool.query("update runners set name = 'Renamed laptop' where id = $1", [runner.id]);
    const ev = (await pool.query("select runner_name from activity_events where record_id = $1 and run_id = $2 and type = 'record.updated'", [w.ticket, w.run_id])).rows;
    expect(ev.every((e: { runner_name: string }) => e.runner_name === MACHINE)).toBe(true);
    await pool.query('update runners set name = $1 where id = $2', [MACHINE, runner.id]);
  });
});

describe('AC2: the credential expires with the run or the lease, and is refused after', () => {
  it('is refused once its expiry passes, BY CLOCK, before any sweeper has run', async () => {
    const agent = await mkAgent(owner, 'Clock bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await patchTicket(w.credential.token, w.ticket, 'live')).statusCode).toBe(200);
    await pool.query("update api_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [sha256(w.credential.token)]);
    const res = await patchTicket(w.credential.token, w.ticket, 'too late');
    expect(res.statusCode, res.body).toBe(401);
    expect(res.body).toContain('lease ended');
  });

  it('is refused once the WAKE\'S lease passes even if the credential row still looks live (no sweeper involved)', async () => {
    const agent = await mkAgent(owner, 'Lease bot');
    await assign(agent);
    const w = await claimFor(agent);
    await pool.query("update agent_wakes set lease_expires_at = now() - interval '1 second' where id = $1", [w.id]);
    const res = await patchTicket(w.credential.token, w.ticket, 'lease gone');
    expect(res.statusCode, res.body).toBe(401);
    expect(res.body).toContain('no longer valid');
  });

  it('the reaper revokes it when it returns an expired lease to the queue; a re-claim gets a FRESH credential and the old one stays dead', async () => {
    const agent = await mkAgent(owner, 'Reaped bot');
    await assign(agent);
    const w = await claimFor(agent);
    await pool.query("update agent_wakes set lease_expires_at = now() - interval '1 second' where id = $1", [w.id]);
    await wakes.reapExpiredLeases();
    expect((await tokenRow(w.credential.token)).revoked_at).not.toBeNull();
    expect((await patchTicket(w.credential.token, w.ticket, 'after reap')).statusCode).toBe(401);
    const again = wakesOf(await claim(runner.token))[0]!;
    expect(again.id).toBe(w.id);
    expect(again.credential.token).not.toBe(w.credential.token);
    expect((await patchTicket(again.credential.token, w.ticket, 'second try')).statusCode).toBe(200);
    expect((await patchTicket(w.credential.token, w.ticket, 'first one stays dead')).statusCode).toBe(401);
  });

  it('completing the run revokes it at once (and a retried complete is idempotent)', async () => {
    const agent = await mkAgent(owner, 'Done bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await patchTicket(w.credential.token, w.ticket, 'working')).statusCode).toBe(200);
    expect((await complete(w)).statusCode).toBe(200);
    expect((await tokenRow(w.credential.token)).revoked_at).not.toBeNull();
    expect((await patchTicket(w.credential.token, w.ticket, 'after done')).statusCode).toBe(401);
    expect((await complete(w)).statusCode).toBe(200);
  });

  it('cancelling the Run revokes it', async () => {
    const agent = await mkAgent(owner, 'Cancelled bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect(await wakes.cancelForRun(ws, w.run_id!)).toBe(1);
    expect((await patchTicket(w.credential.token, w.ticket, 'after cancel')).statusCode).toBe(401);
  });

  it('removing the Runner revokes every credential minted for it', async () => {
    const r2 = await pairRunner(owner, []);
    const agent = await mkAgent(owner, 'Removed-runner bot');
    await assign(agent, r2);
    const w = await claimFor(agent, r2.token);
    expect((await patchTicket(w.credential.token, w.ticket, 'before removal')).statusCode).toBe(200);
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/${r2.id}`)).statusCode).toBeLessThan(300);
    expect((await tokenRow(w.credential.token)).revoked_at).not.toBeNull();
    expect((await patchTicket(w.credential.token, w.ticket, 'after removal')).statusCode).toBe(401);
  });

  it('turning the agent off refuses its credential on the next call', async () => {
    const agent = await mkAgent(owner, 'Switched-off bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await as(owner.token, 'PATCH', `/workspaces/${ws}/databases/${agentsDbId}/records/${agent}`, { values: { enabled: false } })).statusCode).toBe(200);
    const res = await patchTicket(w.credential.token, w.ticket, 'after off');
    expect(res.statusCode, res.body).toBe(401);
    expect(res.body).toContain('turned off');
  });

  it('the heartbeat slides the credential\'s expiry with the lease', async () => {
    const agent = await mkAgent(owner, 'Beating bot');
    await assign(agent);
    const w = await claimFor(agent);
    await pool.query("update api_tokens set expires_at = now() + interval '5 seconds' where token_hash = $1", [sha256(w.credential.token)]);
    expect((await asRunner(runner.token, 'POST', `/runner/v1/wakes/${w.id}/heartbeat`, { nonce: w.nonce })).statusCode).toBe(200);
    const after = new Date((await tokenRow(w.credential.token)).expires_at).getTime() - Date.now();
    expect(after).toBeGreaterThan(60_000);
  });
});

describe('AC3: it reaches only the agent\'s scope; a credential binds to its own run; gated writes are staged; nothing is self-approved', () => {
  it('works only for ITS agent, its run and its Runner: run X\'s credential never names run Y, and another Runner\'s claim cannot use it', async () => {
    const a1 = await mkAgent(owner, 'Run X bot');
    const a2 = await mkAgent(owner, 'Run Y bot');
    await assign(a1);
    await assign(a2);
    const x = await claimFor(a1);
    const y = await claimFor(a2);
    expect(x.run_id).not.toBe(y.run_id);
    await patchTicket(x.credential.token, x.ticket, 'from x');
    await patchTicket(y.credential.token, y.ticket, 'from y');
    const stamp = async (ticket: string) => (await pool.query("select distinct run_id, agent_id from record_field_changes where record_id = $1 and run_id is not null", [ticket])).rows;
    expect(await stamp(x.ticket)).toEqual([{ run_id: x.run_id, agent_id: a1 }]);
    expect(await stamp(y.ticket)).toEqual([{ run_id: y.run_id, agent_id: a2 }]);
    // Completing X ends X only.
    expect((await complete(x)).statusCode).toBe(200);
    expect((await patchTicket(x.credential.token, x.ticket, 'x after done')).statusCode).toBe(401);
    expect((await patchTicket(y.credential.token, y.ticket, 'y still live')).statusCode).toBe(200);
  });

  it('does not reach what its owner cannot: a member-owned agent cannot touch a restricted database it has no grant on', async () => {
    const space = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Private HR' })).json();
    const secretDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space.id, name: 'Salaries' })).json().id as string;
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${secretDb}`, { restricted: true })).statusCode).toBeLessThan(300);
    const rec = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secretDb}/records`, { values: { name: 'Everyone' } })).json().id as string;
    const agent = await mkAgent(owner, 'Nosy bot');
    await assign(agent);
    const w = await claimFor(agent);
    const get = await as(w.credential.token, 'GET', `/workspaces/${ws}/databases/${secretDb}/records/${rec}`);
    const ownerGet = await as(owner.token, 'GET', `/workspaces/${ws}/databases/${secretDb}/records/${rec}`);
    expect(ownerGet.statusCode).toBe(404);
    expect(get.statusCode).toBe(404);
  });

  it('a gated write is STAGED (202, nothing written) and the run credential cannot approve or reject anything', async () => {
    const agent = await mkAgent(owner, 'Gated bot');
    await assign(agent);
    const gate = await as(admin.token, 'POST', `/workspaces/${ws}/agent-write-gates`, { agent_id: agent, operations: ['update'], database_id: ticketsDbId });
    expect(gate.statusCode, gate.body).toBe(201);
    const w = await claimFor(agent);
    const held = await patchTicket(w.credential.token, w.ticket, 'held for approval');
    expect(held.statusCode, held.body).toBe(202);
    expect((await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`)).json().values[notesApi]).toBe('start');
    const approvalId = held.json().approval_id as string;
    for (const verb of ['approve', 'reject']) {
      const res = await as(w.credential.token, 'POST', `/workspaces/${ws}/approvals/${approvalId}/${verb}`);
      expect(res.statusCode, res.body).toBe(403);
    }
    expect((await as(w.credential.token, 'POST', `/workspaces/${ws}/agents/runs/${w.run_id}/approve`)).statusCode).toBe(403);
    // ...and a person approves it: applied, attributed to the agent AND the run that proposed it? (the approver's request has no run).
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/approvals/${approvalId}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();
    expect((await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`)).json().values[notesApi]).toBe('held for approval');
  });

  it('cannot be used on the Runner API, by anyone: only the Runner token works there, and a Runner token still does not work here', async () => {
    const agent = await mkAgent(owner, 'Confined bot');
    await assign(agent);
    const w = await claimFor(agent);
    expect((await claim(w.credential.token)).statusCode).toBe(401);
    expect((await asRunner(w.credential.token, 'POST', `/runner/v1/wakes/${w.id}/heartbeat`, { nonce: w.nonce })).statusCode).toBe(401);
    expect((await asRunner(w.credential.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: w.nonce, exit: 'ok' })).statusCode).toBe(401);
    expect((await as(runner.token, 'GET', `/workspaces/${ws}/spaces`)).statusCode).toBe(401);
    // another workspace is a 404, like any workspace-scoped token
    const otherWs = (await as(admin.token, 'POST', '/workspaces', { name: 'Elsewhere' })).json().id;
    expect((await as(w.credential.token, 'GET', `/workspaces/${otherWs}/spaces`)).statusCode).toBe(404);
  });

  it('an agent of ANOTHER member cannot be claimed or credentialed by this Runner', async () => {
    const theirs = await mkAgent(other, 'Other member bot');
    // Not assigned to the owner's Runner: the assignment itself is refused to a non-owner of the Runner.
    expect((await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${theirs}`, { runner_id: runner.id })).statusCode).toBeGreaterThanOrEqual(400);
    const ticket = await mkTicket('Not for this runner');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${theirs}/delegate`, { record_id: ticket });
    expect(wakesOf(await claim(runner.token))).toHaveLength(0);
  });
});

describe('depth rides on the credential: an agent comment wakes within the cap, and a mention loop terminates', () => {
  it('an agent comment with NO run behind it (an older agent token) still wakes nothing', async () => {
    const a = await mkAgent(owner, 'Old-token author');
    const b = await mkAgent(owner, 'Old-token target');
    await assign(b);
    const tok = await as(owner.token, 'POST', '/me/tokens', { name: 'old agent token', workspace_id: ws, scope: 'write', agent_id: a });
    const ticket = await mkTicket('Old token ticket');
    const res = await commentOn(tok.json().token, ticket, [para(agentMention(b))]);
    expect(res.statusCode, res.body).toBe(201);
    expect((await pool.query('select count(*)::int as n from agent_wakes where agent_id = $1', [b])).rows[0].n).toBe(0);
  });

  it('A mentions B, B mentions A, A mentions B ... stops at the cap, creates no wake past it, and tells the author', async () => {
    const A = await mkAgent(owner, 'Loop A');
    const B = await mkAgent(owner, 'Loop B');
    await assign(A);
    await assign(B);
    const ticket = await mkTicket('Ping pong');
    const wakeDepths = async (agent: string) => (await pool.query('select depth from agent_wakes where agent_id = $1 order by created_at', [agent])).rows.map((r: { depth: number }) => r.depth);
    // a PERSON mentions A: depth 0
    const first = await commentOn(owner.token, ticket, [para(agentMention(A), txt(' please look'))]);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().agent_wakes).toEqual([{ agent_id: A, woken: true }]);
    const claimOne = async (expectAgent: string, expectDepth: number): Promise<Claimed> => {
      const got = wakesOf(await claim(runner.token));
      expect(got).toHaveLength(1);
      expect(got[0]!.depth).toBe(expectDepth);
      expect((await pool.query('select run_depth, agent_id from api_tokens where token_hash = $1', [sha256(got[0]!.credential.token)])).rows[0]).toMatchObject({ run_depth: expectDepth, agent_id: expectAgent });
      return got[0]!;
    };
    const a0 = await claimOne(A, 0);
    const toB = await commentOn(a0.credential.token, ticket, [para(agentMention(B), txt(' your turn'))]);
    expect(toB.json().agent_wakes).toEqual([{ agent_id: B, woken: true }]);
    expect((await complete(a0)).statusCode).toBe(200);
    const b1 = await claimOne(B, 1);
    const toA = await commentOn(b1.credential.token, ticket, [para(agentMention(A), txt(' back to you'))]);
    expect(toA.json().agent_wakes).toEqual([{ agent_id: A, woken: true }]);
    expect((await complete(b1)).statusCode).toBe(200);
    const a2 = await claimOne(A, WAKE_MAX_DEPTH);
    // depth 2 = the cap: the next hop would be depth 3
    const past = await commentOn(a2.credential.token, ticket, [para(agentMention(B), txt(' once more'))]);
    expect(past.statusCode, past.body).toBe(201); // the comment itself is written
    expect(past.json().agent_wakes).toEqual([{ agent_id: B, woken: false, message: expect.stringContaining('too many times in a row') }]);
    expect((await complete(a2)).statusCode).toBe(200);
    expect(await wakeDepths(B)).toEqual([1]); // no wake past the cap
    expect(await wakeDepths(A)).toEqual([0, 2]);
    expect(wakesOf(await claim(runner.token))).toHaveLength(0); // the loop has ended: nothing is left to claim
  });
});

describe('MUST KEEP: the other credentials, untouched', () => {
  it('an OAuth-less PAT, a session and a Runner token each still answer exactly where they did', async () => {
    const pat = await as(other.token, 'POST', '/me/tokens', { name: 'other PAT', workspace_id: ws, scope: 'read' });
    expect((await as(pat.json().token, 'GET', `/workspaces/${ws}/spaces`)).statusCode).toBe(200);
    expect((await as(other.token, 'GET', `/workspaces/${ws}/spaces`)).statusCode).toBe(200);
    expect((await claim(runner.token)).statusCode).toBeLessThan(300);
    // a guest still cannot create a PAT (#1091)
    expect((await as(guest.token, 'POST', '/me/tokens', { name: 'guest PAT', workspace_id: ws, scope: 'read' })).statusCode).toBe(403);
  });
});
