import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * ticket #1195 — an agent's scope is its databases PLUS its spaces; a space resolves to its databases AT CALL TIME.
 * Real fixtures: an ADMIN, a MEMBER who manages the agents, a Runner paired to that member, and the per-run credential a claimed
 * wake hands over (the thing that actually carries the scope). Every refusal is asserted on the response BODY as well as the status:
 * a refusal must not say what is on the other side.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let admin: { token: string };
let manager: Person;
let runner: { token: string; id: string };
let aiOwn = '';
let scopeIds: Record<string, string> = {};
let workSpace = '', otherSpace = '', personalSpaceName = '';
let ledger = '', payroll = '', otherDb = '';
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;
const SECRET = 'Payroll secret row';

async function mkAgent(name: string, extra: Record<string, unknown>): Promise<string> {
  const res = await as(manager.token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

type Claimed = { credential: { token: string }; agent: { scope: { enforced: boolean; databases: Array<{ id: string; name: string; via: string }>; unresolved: string[] } } };
async function claimFor(agent: string): Promise<Claimed> {
  const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ledger}/records`, { values: { name: `T ${agent.slice(0, 4)}` } })).json().id as string;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const res = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().wakes[0] as Claimed;
}

const create = (token: string, db: string, name: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } });
const list = (token: string, db: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 5 });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SpaceTgtAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Space target WS' })).json().id;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');

  const mkSpace = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
  workSpace = await mkSpace('Work');
  otherSpace = await mkSpace('Other');
  const mkDb = async (space: string, name: string) => (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  ledger = await mkDb(workSpace, 'Ledger');
  payroll = await mkDb(workSpace, 'Payroll');
  otherDb = await mkDb(otherSpace, 'Elsewhere');
  await create(admin.token, payroll, SECRET);
  await setRestricted(app, admin.token, ws, 'database', payroll); // the manager has no grant on it
  const personal = await as(admin.token, 'POST', `/workspaces/${ws}/spaces/personal`);
  expect(personal.statusCode, personal.body).toBeLessThan(300);
  personalSpaceName = personal.json().name as string;

  manager = await joinAs(app, admin.token, ws, 'SpaceTgtManager', 'member');
  runner = await (async () => {
    const code = (await as(manager.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
    const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, machine_name: 'Test machine', tools: [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }], runner_version: '0.1.0', protocol_version: 1 });
    expect(paired.statusCode, paired.body).toBe(201);
    const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
    expect((await as(manager.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
    return { token, id: r.id };
  })();
}, 240_000);
afterAll(async () => { await app.close(); });

async function assign(agent: string) {
  expect((await as(manager.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id })).statusCode).toBe(200);
}

describe('#1195 an agent that works in a SPACE', () => {
  let agent = '';
  let credential = '';

  it('claims a credential whose scope lists the space\'s databases the manager can open (not the restricted one)', async () => {
    agent = await mkAgent('Space worker', { target_spaces: 'Work' });
    await assign(agent);
    const claimed = await claimFor(agent);
    credential = claimed.credential.token;
    expect(claimed.agent.scope.enforced).toBe(true);
    expect(claimed.agent.scope.databases.map((d) => d.name)).toEqual(['Ledger']);
    expect(JSON.stringify(claimed.agent.scope)).not.toContain('Payroll');
  });

  it('AC1: reads and writes every database of the space, including one created AFTER the hire', async () => {
    expect((await list(credential, ledger)).statusCode).toBeLessThan(300);
    expect((await create(credential, ledger, 'agent wrote this')).statusCode).toBe(201);
    const later = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: workSpace, name: 'Added later' })).json().id as string;
    const w = await create(credential, later, 'in the new database');
    expect(w.statusCode, w.body).toBe(201);
    expect((await list(credential, later)).statusCode).toBeLessThan(300);
    // and the agent API lists it too (AC3), same call, no re-hire
    const scope = (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json();
    expect(scope.databases.map((d: { name: string }) => d.name)).toEqual(['Added later', 'Ledger']);
    expect(scope.databases.every((d: { via: string }) => d.via === 'space')).toBe(true);
    expect(scope.spaces.map((s: { name: string }) => s.name)).toEqual(['Work']);
  });

  it('AC2: refused a database outside its spaces, with nothing from the other side in the body', async () => {
    for (const res of [await list(credential, otherDb), await create(credential, otherDb, 'smuggled')]) {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(403);
      expect(res.body).not.toContain('Elsewhere');
    }
  });

  it('AC2: refused a database in its space that its MANAGER cannot open (restricted), and the scope API says one was withheld', async () => {
    const r = await list(credential, payroll);
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(403);
    expect(r.body).not.toContain(SECRET);
    expect((await create(credential, payroll, 'smuggled')).statusCode).toBeGreaterThanOrEqual(403);
    const scope = (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json();
    expect(scope.withheld_count).toBe(1);
    expect(JSON.stringify(scope.databases)).not.toContain('Payroll');
  });

  it('is live in the other direction too: a database moved OUT of the space leaves the scope on the next call', async () => {
    const moving = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: workSpace, name: 'Moving' })).json().id as string;
    expect((await create(credential, moving, 'in')).statusCode).toBe(201);
    const moved = await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${moving}`, { space_id: otherSpace });
    if (moved.statusCode < 300) expect((await create(credential, moving, 'out')).statusCode).toBeGreaterThanOrEqual(403);
  });
});

describe('#1195 a personal space is never reachable, and an unresolvable target fails closed', () => {
  it('AC2: a personal space named as a target resolves to nothing: the credential reaches no database at all', async () => {
    const agent = await mkAgent('Personal peeker', { target_spaces: personalSpaceName });
    await assign(agent);
    const claimed = await claimFor(agent);
    expect(claimed.agent.scope.enforced).toBe(true);
    expect(claimed.agent.scope.databases).toEqual([]);
    expect(claimed.agent.scope.unresolved).toEqual([personalSpaceName]);
    expect((await list(claimed.credential.token, ledger)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await list(claimed.credential.token, otherDb)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('a named database plus a space: both are in scope, nothing else', async () => {
    const agent = await mkAgent('Mixed', { target_spaces: 'Work', target_databases: 'Elsewhere' });
    await assign(agent);
    const claimed = await claimFor(agent);
    expect(claimed.agent.scope.databases.map((d) => `${d.name}:${d.via}`).sort()).toEqual(['Added later:space', 'Elsewhere:database', 'Ledger:space'].sort());
    expect(JSON.stringify(claimed.agent.scope)).not.toContain('Payroll');
    expect((await create(claimed.credential.token, otherDb, 'named db')).statusCode).toBe(201);
    expect((await create(claimed.credential.token, ledger, 'space db')).statusCode).toBe(201);
  });
});

describe('#1195 MUST KEEP: a database-only agent is unchanged', () => {
  it('its credential is not bound (target_databases stays the agent\'s brief), and the scope API says enforced: false', async () => {
    const agent = await mkAgent('Db only', { target_databases: 'Ledger' });
    await assign(agent);
    const claimed = await claimFor(agent);
    expect(claimed.agent.scope.enforced).toBe(false);
    expect(claimed.agent.scope.databases.map((d) => d.name)).toEqual(['Ledger']);
    expect((await create(claimed.credential.token, otherDb, 'as before')).statusCode).toBe(201);
    const scope = (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json();
    expect(scope.enforced).toBe(false);
  });

  it('an agent cannot widen its own scope by writing its own "Target spaces" (a person sets where it works)', async () => {
    const agent = await mkAgent('Db only 2', { target_databases: 'Ledger' });
    await assign(agent);
    const claimed = await claimFor(agent);
    const res = await as(claimed.credential.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { target_spaces: 'Work' } });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    const row = await pool.query("select values from records where id = $1", [agent]);
    expect(JSON.stringify(row.rows[0].values)).not.toContain('Work');
  });
});
