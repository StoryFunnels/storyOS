import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { RecordsService } from '../src/records/records.service';
import { asActingAgent, asApprovedAgentWrite } from '../src/records/agent-write-context';

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

describe('#1330 a database-only agent is bound to the databases it names', () => {
  // Until ticket #1330 this block asserted the opposite ("target_databases stays the agent's brief", enforced: false). That was the
  // documented design and it let a database-only credential reach every database its owner could, Members included.
  it('its credential is bound (enforced: true): it reaches the database it names and not another database', async () => {
    const agent = await mkAgent('Db only', { target_databases: 'Ledger' });
    await assign(agent);
    const claimed = await claimFor(agent);
    expect(claimed.agent.scope.enforced).toBe(true);
    expect(claimed.agent.scope.databases.map((d) => d.name)).toEqual(['Ledger']);
    expect((await create(claimed.credential.token, ledger, 'its own database')).statusCode).toBe(201);
    expect((await create(claimed.credential.token, otherDb, 'not its database')).statusCode).toBeGreaterThanOrEqual(403);
    const scope = (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json();
    expect(scope.enforced).toBe(true);
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

describe('#1195 the scope API is admin-only', () => {
  it('a non-admin is refused and the body names no database', async () => {
    const closed = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Closed' })).json().id as string;
    await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: closed, name: 'Vault' });
    const agent = await mkAgent('Vault worker', { target_spaces: 'Closed' });
    const res = await as(manager.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain('Vault');
  });
});

/**
 * ticket #1336 — an agent that CAN write the Agents database (it names "Agents" in its own target databases) must still not be able
 * to rewrite the scope fields of an agent record: target_databases and scopes join target_spaces/tools/model/budget as settings a person sets.
 * The "cannot widen its own scope" test above passes only because that agent cannot reach Agents at all.
 */
describe('#1336 an agent that can reach the Agents database cannot rewrite agent scope', () => {
  const agentRow = async (id: string) => (await pool.query('select values from records where id = $1', [id])).rows[0].values as Record<string, unknown>;
  const fieldId = async (apiName: string) => (await pool.query('select id from fields where database_id = $1 and api_name = $2', [agentsDbId, apiName])).rows[0].id as string;
  let agent = '';
  let token = '';

  beforeAll(async () => {
    agent = await mkAgent('Scope probe', { target_databases: `${ledger}, ${agentsDbId}` }) // the Agents database by ID: a name never binds a system database;
    await assign(agent);
    token = (await claimFor(agent)).credential.token;
    // The premise of the probe: this credential really does reach the Agents database.
    expect((await as(token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/query`, { limit: 1 })).statusCode).toBeLessThan(300);
  });

  it('refuses its own target_databases (403) and the stored value is unchanged', async () => {
    const before = (await agentRow(agent))[await fieldId('target_databases')];
    const res = await as(token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { target_databases: `${ledger}, ${agentsDbId}, ${otherDb}` } });
    expect(res.statusCode, res.body).toBe(403);
    expect((await agentRow(agent))[await fieldId('target_databases')]).toEqual(before);
  });

  it('refuses its own scopes (403) and the stored value is unchanged', async () => {
    const before = (await agentRow(agent))[await fieldId('scopes')];
    const res = await as(token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { scopes: [scopeIds['admin']] } });
    expect(res.statusCode, res.body).toBe(403);
    expect((await agentRow(agent))[await fieldId('scopes')]).toEqual(before);
  });

  it("refuses writing ANOTHER agent record's scope fields too", async () => {
    const other = await mkAgent('Scope victim', { target_databases: 'Ledger' });
    const res = await as(token, 'PATCH', `${agentsRecords()}/${other}`, { values: { target_databases: 'Elsewhere', scopes: [scopeIds['admin']] } });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.stringify(await agentRow(other))).not.toContain('Elsewhere');
  });

  it('MUST KEEP: a person who manages agents can still change them', async () => {
    const res = await as(manager.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { target_databases: `${ledger}, ${agentsDbId}, ${otherDb}`, scopes: [scopeIds['read']] } });
    expect(res.statusCode, res.body).toBe(200);
    const row = await agentRow(agent);
    expect(row[await fieldId('target_databases')]).toBe(`${ledger}, ${agentsDbId}, ${otherDb}`);
    expect(row[await fieldId('scopes')]).toEqual([scopeIds['read']]);
  });

  it('MUST KEEP: a write a person APPROVED is applied (replayed with source agent inside the approval marker); the same write unapproved is refused', async () => {
    const records = app.get(RecordsService);
    const target = await mkAgent('Approved scope target', { target_databases: 'Ledger' });
    const widen = { target_databases: `${ledger}, ${otherDb}` };
    // Unapproved, agent-origin: refused, nothing stored.
    await expect(records.update(ws, agentsDbId, target, widen, manager.id, 0, 'agent', agent, 'Scope probe')).rejects.toThrow(/cannot change/);
    expect((await agentRow(target))[await fieldId('target_databases')]).toBe('Ledger');
    // Inside the approvals executor's marker: applied. Approving is person-only (approval-requires-human.test.ts).
    await asApprovedAgentWrite(() => records.update(ws, agentsDbId, target, widen, manager.id, 0, 'agent', agent, 'Scope probe'));
    expect((await agentRow(target))[await fieldId('target_databases')]).toBe(widen.target_databases);
    // The marker does not widen what it covers: Tools/Model/budget in the same write still refuse.
    await expect(asApprovedAgentWrite(() => records.update(ws, agentsDbId, target, { ...widen, tools: 'x' }, manager.id, 0, 'agent', agent, 'Scope probe'))).rejects.toThrow(/cannot change/);
  });

  it('MUST KEEP: an agent can still write the fields that are not scope', async () => {
    const res = await as(token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { enabled: false } });
    expect(res.statusCode, res.body).toBe(200);
  });
});

/**
 * ticket #1338 — sibling of #1336: an agent credential that can reach the Agents database must not CREATE an agent whose reach is
 * wider than its own. The new agent's databases must be a subset of the creator's scope (named by id: a name resolves later, and a
 * database created tomorrow under the same name could be outside it), its scopes no higher, and an agent that names no database at all
 * (which reaches everything its owner can) is only mintable by a creator that is itself unbound. A person, a pack install and an
 * architect build are untouched; a write a person approved applies.
 */
describe('#1338 an agent that can reach the Agents database cannot create an agent wider than itself', () => {
  const fieldId = async (apiName: string) => (await pool.query('select id from fields where database_id = $1 and api_name = $2', [agentsDbId, apiName])).rows[0].id as string;
  const countNamed = async (name: string) => Number((await pool.query('select count(*)::int as n from records where database_id = $1 and title = $2', [agentsDbId, name])).rows[0].n);
  let membersDb = '';
  let bound = '';
  let boundToken = '';
  let unbound = '';
  let unboundToken = '';
  const spawn = (token: string, name: string, values: Record<string, unknown>) => as(token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, ...values } });

  beforeAll(async () => {
    membersDb = (await pool.query("select id from databases where workspace_id = $1 and is_system = true and system_key = 'members'", [ws])).rows[0].id as string;
    bound = await mkAgent('Create probe', { target_databases: `${ledger}, ${agentsDbId}`, scopes: [scopeIds['write']] });
    await assign(bound);
    boundToken = (await claimFor(bound)).credential.token;
    expect((await as(boundToken, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/query`, { limit: 1 })).statusCode).toBeLessThan(300);
    unbound = await mkAgent('Create probe unbound', { scopes: [scopeIds['write']] });
    await assign(unbound);
    const claimed = await claimFor(unbound);
    expect(claimed.agent.scope.enforced).toBe(false);
    unboundToken = claimed.credential.token;
  });

  it('refuses a new agent that names a database outside its own scope (403) and stores nothing', async () => {
    const res = await spawn(boundToken, 'Wider by database', { target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['read']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain('Elsewhere');
    expect(await countNamed('Wider by database')).toBe(0);
  });

  it('refuses a new agent that names a system database the creator cannot reach, by id', async () => {
    const res = await spawn(boundToken, 'Wider by system db', { target_databases: `${ledger}, ${membersDb}`, scopes: [scopeIds['read']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await countNamed('Wider by system db')).toBe(0);
  });

  it('refuses a new agent that names no database at all (an unbound agent reaches more than a bound creator)', async () => {
    const res = await spawn(boundToken, 'Wider by silence', { scopes: [scopeIds['read']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await countNamed('Wider by silence')).toBe(0);
  });

  it('refuses a new agent that names a database by NAME (a name binds later, and could bind something outside the creator)', async () => {
    const res = await spawn(boundToken, 'Wider by name', { target_databases: 'Ledger', scopes: [scopeIds['read']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('by id'); // the refusal says how to do it right, not only that it is wrong
    expect(await countNamed('Wider by name')).toBe(0);
  });

  it('refuses a new agent with higher scopes than the creator holds', async () => {
    const res = await spawn(boundToken, 'Wider by scopes', { target_databases: ledger, scopes: [scopeIds['admin']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await countNamed('Wider by scopes')).toBe(0);
  });

  it('refuses the same widening through the batch endpoint and through duplicate', async () => {
    const batch = await as(boundToken, 'POST', `${agentsRecords()}/batch`, { records: [{ values: { name: 'Batch wider', target_databases: otherDb } }] });
    expect(batch.statusCode, batch.body).toBe(403);
    const wide = await mkAgent('Wide source', { target_databases: `${ledger}, ${otherDb}` });
    const dup = await as(boundToken, 'POST', `${agentsRecords()}/${wide}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(403);
    expect(await countNamed('Batch wider')).toBe(0);
    expect(await countNamed('Wide source (copy)')).toBe(0);
  });

  it("allows a new agent whose databases and scopes are a subset of the creator's (and the stored value is what was asked for)", async () => {
    const res = await spawn(boundToken, 'Narrower child', { target_databases: ledger, scopes: [scopeIds['read']] });
    expect(res.statusCode, res.body).toBe(201);
    const row = (await pool.query('select values from records where id = $1', [res.json().id])).rows[0].values as Record<string, unknown>;
    expect(row[await fieldId('target_databases')]).toBe(ledger);
    expect((await spawn(boundToken, 'Equal child', { target_databases: `${ledger}, ${agentsDbId}`, scopes: [scopeIds['write']] })).statusCode).toBe(201);
  });

  it('an agent that is itself unbound may create an unbound agent, and one that names databases (its owner reach is the ceiling), but not higher scopes', async () => {
    expect((await spawn(unboundToken, 'Unbound child', { scopes: [scopeIds['read']] })).statusCode).toBe(201);
    expect((await spawn(unboundToken, 'Unbound child named', { target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['write']] })).statusCode).toBe(201);
    const res = await spawn(unboundToken, 'Unbound child admin', { scopes: [scopeIds['admin']] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await countNamed('Unbound child admin')).toBe(0);
  });

  it('MUST KEEP: a person who manages agents creates any agent they like', async () => {
    const res = await spawn(manager.token, 'Person made', { target_databases: `${ledger}, ${otherDb}, ${membersDb}`, scopes: [scopeIds['admin']] });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('MUST KEEP: a create made by an internal build (no agent credential at the door) with source agent still applies, as a pack install and an architect build do', async () => {
    const records = app.get(RecordsService);
    const made = await records.create(ws, agentsDbId, { name: 'Built by a person-approved build', enabled: true, target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['admin']] }, manager.id, 0, 'agent');
    expect(made.id).toBeTruthy();
  });

  it('MUST KEEP: a write a person APPROVED (the approval marker) applies; the same create unapproved is refused, and so is a run-executor create', async () => {
    const records = app.get(RecordsService);
    const widen = { name: 'Approved wide child', enabled: true, target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['read']] };
    await expect(records.create(ws, agentsDbId, widen, manager.id, 0, 'agent', bound, 'Create probe')).rejects.toThrow(/cannot|reach|scope/i);
    await expect(asActingAgent({ agentId: bound, agentName: 'Create probe' }, () => records.create(ws, agentsDbId, widen, manager.id, 0, 'agent'))).rejects.toThrow(/cannot|reach|scope/i);
    expect(await countNamed('Approved wide child')).toBe(0);
    await asApprovedAgentWrite(() => records.create(ws, agentsDbId, widen, manager.id, 0, 'agent', bound, 'Create probe'));
    expect(await countNamed('Approved wide child')).toBe(1);
  });
});

/**
 * ticket #1338, second half — the SAME rule on every door that creates a record, keyed on the credential the work ORIGINATED with and
 * not on the `source` label the path writes with. copy_records and the CSV importer apply with source 'automation', and a first version of
 * the guard that looked only at source 'agent' let both through.
 */
describe('#1338 copy and import cannot mint a wider agent either', () => {
  const countNamed = async (name: string) => Number((await pool.query('select count(*)::int as n from records where database_id = $1 and title = $2', [agentsDbId, name])).rows[0].n);
  const fieldRow = async (apiName: string) => (await pool.query('select id from fields where database_id = $1 and api_name = $2', [agentsDbId, apiName])).rows[0].id as string;
  let wideSource = '';
  let unboundToken2 = '';
  let boundToken2 = '';
  let minted = '';
  let boundAgent = '';

  const copy = (token: string, ids: string[]) => as(token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/copy`, { record_ids: ids, target_database_id: agentsDbId, dry_run: false });
  const multipartBody = (fields: Record<string, string>, csv: string) => {
    const boundary = 'X-1338-BOUNDARY';
    const parts = Object.entries(fields).map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
    return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };
  const importCsv = async (token: string, name: string) => {
    const body = multipartBody(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'Scopes', to: { kind: 'existing', field_id: await fieldRow('scopes') } },
          { column: 'Targets', to: { kind: 'existing', field_id: await fieldRow('target_databases') } },
        ]),
        dry_run: 'false',
      },
      `Name,Scopes,Targets\n${name},admin,${otherDb}`,
    );
    return app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/databases/${agentsDbId}/import`, headers: { ...authed(token), ...body.headers }, payload: body.payload as never });
  };

  beforeAll(async () => {
    wideSource = await mkAgent('Copy source wide', { target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['admin']] });
    const u = await mkAgent('Copy probe unbound', { scopes: [scopeIds['write']] });
    await assign(u);
    unboundToken2 = (await claimFor(u)).credential.token;
    const b = await mkAgent('Copy probe bound', { target_databases: `${ledger}, ${agentsDbId}`, scopes: [scopeIds['write']] });
    await assign(b);
    boundAgent = b;
    boundToken2 = (await claimFor(b)).credential.token;
    const m = await mkAgent('Copy probe minted', { scopes: [scopeIds['write']] });
    const res = await as(manager.token, 'POST', '/me/tokens', { name: 'minted agent token', workspace_id: ws, scope: 'write', agent_id: m });
    expect(res.statusCode, res.body).toBeLessThan(300);
    minted = res.json().token as string;
  });

  for (const who of ['unbound run credential', 'bound run credential', 'member-minted agent token'] as const) {
    const token = () => (who === 'unbound run credential' ? unboundToken2 : who === 'bound run credential' ? boundToken2 : minted);
    it(`copy_records: a ${who} cannot copy an admin-scoped agent record (403, nothing created)`, async () => {
      const res = await copy(token(), [wideSource]);
      expect([403, 422], res.body).toContain(res.statusCode); // a refusal: the apply paths report a refused row as a 422 with nothing written
      expect(await countNamed('Copy source wide')).toBe(1); // only the source itself
    });
    it(`CSV import: a ${who} cannot import an agent record with admin scopes (403, nothing created)`, async () => {
      const name = `Imported wide ${who}`;
      const res = await importCsv(token(), name);
      expect([403, 422], res.body).toContain(res.statusCode); // a refusal: the apply paths report a refused row as a 422 with nothing written
      expect(await countNamed(name)).toBe(0);
    });
  }

  it('MUST KEEP: a member copies and imports agent records exactly as before', async () => {
    const copied = await copy(manager.token, [wideSource]);
    expect(copied.statusCode, copied.body).toBeLessThan(300);
    expect(await countNamed('Copy source wide')).toBe(2);
    const imported = await importCsv(manager.token, 'Imported by a person');
    expect(imported.statusCode, imported.body).toBeLessThan(300);
    expect(await countNamed('Imported by a person')).toBe(1);
  });

  it('automation create_record: an agent write that sets off a rule creating an agent record carries its origin, and the rule cannot mint a wider agent', async () => {
    const records = app.get(RecordsService);
    const { runWithEventOrigin } = await import('../src/common/credential-context');
    const wide = { name: 'Chained wide agent', enabled: true, target_databases: otherDb, scopes: [scopeIds['admin']] };
    // The write is made with source 'automation' (a rule), but the chain began with a run credential of an agent.
    await expect(runWithEventOrigin({ agentId: boundAgent, agentName: 'Create probe', runId: null, runnerId: runner.id, runnerName: 'Test machine' }, () => records.create(ws, agentsDbId, wide, manager.id, 1, 'automation'))).rejects.toThrow();
    expect(await countNamed('Chained wide agent')).toBe(0);
    // No origin = a rule an admin wrote, firing from a person's change: untouched.
    expect((await records.create(ws, agentsDbId, wide, manager.id, 1, 'automation')).id).toBeTruthy();
  });
});

/**
 * ticket #1352 — the update guard (#1336) is keyed on the credential the work ORIGINATED with, not on the `source` label a path writes
 * under. A CSV import applied its updates with no source at all, so an agent credential rewrote an agent's scopes through it while the same
 * change sent as a PATCH was refused. Every door that ends in records.update / restoreVersion is proved below, for the two credentials
 * that matter: an UNBOUND run credential with a write ceiling (what a Runner is handed) and an agent token a member minted.
 */
describe('#1352 every door that updates an agent record is held to the originating credential', () => {
  const fieldId = async (apiName: string) => (await pool.query('select id from fields where database_id = $1 and api_name = $2', [agentsDbId, apiName])).rows[0].id as string;
  const row = async (id: string) => (await pool.query('select values from records where id = $1', [id])).rows[0].values as Record<string, unknown>;
  let victim = '';
  let victimName = '';
  let runToken = '';
  let patToken = '';
  let boundAgentId = '';
  let before: Record<string, unknown> = {};
  const wide = () => ({ scopes: [scopeIds['admin']], target_databases: otherDb });

  const multipart = (fields: Record<string, string>, csv: string) => {
    const boundary = 'X-1352-BOUNDARY';
    const parts = Object.entries(fields).map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
    return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };
  const importUpsert = async (token: string, dryRun: boolean, columns: Array<[string, string]> = [['Scopes', 'scopes'], ['Targets', 'target_databases']], cells: string[] = ['admin', otherDb]) => {
    const body = multipart(
      {
        mapping: JSON.stringify([{ column: 'Name', to: { kind: 'title' } }, ...(await Promise.all(columns.map(async ([column, api]) => ({ column, to: { kind: 'existing', field_id: await fieldId(api) } }))))]),
        upsert: JSON.stringify({ column: 'Name', on_match: 'update', on_no_match: 'skip' }),
        dry_run: dryRun ? 'true' : 'false',
      },
      `Name,${columns.map(([c]) => c).join(',')}\n${victimName},${cells.join(',')}`,
    );
    return app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/databases/${agentsDbId}/import`, headers: { ...authed(token), ...body.headers }, payload: body.payload as never });
  };
  const unchanged = async () => {
    const now = await row(victim);
    for (const k of ['scopes', 'target_databases', 'target_spaces', 'tools', 'model']) {
      const id = await fieldId(k);
      expect(now[id], `${k} must be unchanged`).toEqual(before[id]);
    }
  };

  beforeAll(async () => {
    victimName = 'Update door victim';
    victim = await mkAgent(victimName, { target_databases: 'Ledger', scopes: [scopeIds['write']] });
    before = await row(victim);
    const u = await mkAgent('Update door unbound', { scopes: [scopeIds['write']] });
    await assign(u);
    const claimed = await claimFor(u);
    expect(claimed.agent.scope.enforced).toBe(false); // unbound
    runToken = claimed.credential.token;
    boundAgentId = u;
    const m = await mkAgent('Update door minted', { scopes: [scopeIds['write']] });
    const res = await as(manager.token, 'POST', '/me/tokens', { name: 'door agent token', workspace_id: ws, scope: 'write', agent_id: m });
    expect(res.statusCode, res.body).toBeLessThan(300);
    patToken = res.json().token as string;
    // The premise: both credentials really do reach the Agents database.
    for (const t of [runToken, patToken]) expect((await as(t, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/query`, { limit: 1 })).statusCode).toBeLessThan(300);
  });

  for (const who of ['unbound run credential', 'member-minted agent token'] as const) {
    const token = () => (who === 'unbound run credential' ? runToken : patToken);

    describe(`as a ${who}`, () => {
      it('baseline: a direct PATCH is refused (403)', async () => {
        const res = await as(token(), 'PATCH', `${agentsRecords()}/${victim}`, { values: wide() });
        expect(res.statusCode, res.body).toBe(403);
        await unchanged();
      });

      it('CSV import upsert (on_match update) is refused with the same 403, and nothing changed', async () => {
        const res = await importUpsert(token(), false);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().message).toMatch(/cannot change an agent/);
        await unchanged();
      });

      it('CSV import upsert is refused for each guarded column on its own (scopes, target databases, model)', async () => {
        for (const [col, api, cell] of [['Scopes', 'scopes', 'admin'], ['Targets', 'target_databases', otherDb], ['Model', 'model', 'some-model']] as const) {
          const res = await importUpsert(token(), false, [[col, api]], [cell]);
          expect(res.statusCode, `${api}: ${res.body}`).toBe(403);
        }
        await unchanged();
      });

      it('a CSV import that only touches fields that are not scope still applies', async () => {
        const res = await importUpsert(token(), false, [['Enabled', 'enabled']], ['true']);
        expect(res.statusCode, res.body).toBeLessThan(300);
        expect(res.json().updated).toBe(1);
      });

      it('the import DRY RUN reports the refusal on the row instead of previewing a success', async () => {
        const res = await importUpsert(token(), true);
        expect(res.statusCode, res.body).toBe(201);
        const body = res.json();
        expect(body.will_update).toBe(0);
        expect(body.will_refuse).toBe(1);
        expect(body.warnings.map((w: { row: number; message: string }) => `${w.row}: ${w.message}`).join('\n')).toMatch(/2: refused: An agent cannot change an agent/);
        await unchanged();
      });

      it('batch update is refused per record (nothing updated) and a bulk job is refused when it is enqueued', async () => {
        const res = await as(token(), 'PATCH', `${agentsRecords()}/batch`, { record_ids: [victim], values: wide() });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().updated).toBe(0);
        expect(res.json().failed[0].message).toMatch(/cannot change an agent/);
        const job = await as(token(), 'POST', `${agentsRecords()}/batch-jobs`, { op: 'update', record_ids: [victim], values: wide() });
        expect(job.statusCode, job.body).toBe(403);
        await unchanged();
      });

      it('copy_records is create-only: its dry run REPORTS a refused agent copy per record instead of previewing a success', async () => {
        const source = await mkAgent(`Copy dry-run source ${who}`, { target_databases: `${ledger}, ${otherDb}`, scopes: [scopeIds['admin']] });
        const res = await as(token(), 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/copy`, { record_ids: [source], target_database_id: agentsDbId, dry_run: true });
        expect(res.statusCode, res.body).toBeLessThan(300);
        expect(res.json().will_refuse).toBe(1);
        expect(res.json().will_create).toBe(0);
        expect(JSON.stringify(res.json().warnings)).toMatch(/refused/);
        const person = await as(manager.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/copy`, { record_ids: [source], target_database_id: agentsDbId, dry_run: true });
        expect(person.json().will_refuse).toBe(0);
        expect(person.json().will_create).toBe(1);
      });

      it('move with a value patch is refused', async () => {
        const res = await as(token(), 'POST', `${agentsRecords()}/${victim}/move`, { values: wide() });
        expect(res.statusCode, res.body).toBe(403);
        await unchanged();
      });

      it('restoring a version of an agent record is refused, and so is undoing a batch update', async () => {
        // A person edits the victim, so there is a captured version to restore.
        const edit = await as(manager.token, 'PATCH', `${agentsRecords()}/${victim}`, { values: { enabled: false } });
        expect(edit.statusCode, edit.body).toBe(200);
        const versions = (await as(manager.token, 'GET', `${agentsRecords()}/${victim}/versions`)).json().data as Array<{ id: string }>;
        expect(versions.length).toBeGreaterThan(0);
        const res = await as(token(), 'POST', `${agentsRecords()}/${victim}/versions/${versions[0]!.id}/restore`);
        expect(res.statusCode, res.body).toBe(403);
        const undo = await as(token(), 'POST', `${agentsRecords()}/batch-update-undo`, { restorable: [{ record_id: victim, version_id: versions[0]!.id }] });
        expect(undo.json().restored).toBe(0);
        expect(undo.json().failed[0].message).toMatch(/cannot change an agent/);
        await unchanged();
      });
    });
  }

  it('an automation chained from an agent write (it carries the run credential origin) cannot rewrite an agent; an automation with no origin can', async () => {
    const records = app.get(RecordsService);
    const { runWithEventOrigin } = await import('../src/common/credential-context');
    const origin = { agentId: boundAgentId, agentName: 'Update door unbound', runId: null, runnerId: runner.id, runnerName: 'Test machine' };
    await expect(runWithEventOrigin(origin, () => records.update(ws, agentsDbId, victim, wide(), manager.id, 1, 'automation'))).rejects.toThrow(/cannot change an agent/);
    await unchanged();
    // The same write from a rule an admin wrote, fired by a person's change: no agent credential behind it.
    await records.update(ws, agentsDbId, victim, { target_databases: 'Ledger' }, manager.id, 1, 'automation');
    // A run executor acting as an agent, writing under an unrelated label.
    await expect(asActingAgent({ agentId: boundAgentId, agentName: 'x' }, () => records.update(ws, agentsDbId, victim, wide(), manager.id, 0, 'automation'))).rejects.toThrow(/cannot change an agent/);
    await unchanged();
  });

  it('a restore carried by an agent origin is refused whatever the label', async () => {
    const records = app.get(RecordsService);
    const { runWithEventOrigin } = await import('../src/common/credential-context');
    const versions = (await as(manager.token, 'GET', `${agentsRecords()}/${victim}/versions`)).json().data as Array<{ id: string }>;
    const origin = { agentId: boundAgentId, agentName: 'x', runId: null, runnerId: runner.id, runnerName: 'Test machine' };
    await expect(runWithEventOrigin(origin, () => records.restoreVersion(ws, agentsDbId, victim, versions[0]!.id, manager.id, 'automation'))).rejects.toThrow(/cannot change an agent/);
    await unchanged();
  });

  it('MUST KEEP: a person changes an agent through PATCH, batch update and a CSV import (dry run and commit)', async () => {
    const patch = await as(manager.token, 'PATCH', `${agentsRecords()}/${victim}`, { values: { scopes: [scopeIds['read']] } });
    expect(patch.statusCode, patch.body).toBe(200);
    const batch = await as(manager.token, 'PATCH', `${agentsRecords()}/batch`, { record_ids: [victim], values: { target_databases: 'Ledger' } });
    expect(batch.json().updated).toBe(1);
    const dry = await importUpsert(manager.token, true);
    expect(dry.statusCode, dry.body).toBe(201);
    expect(dry.json().will_update).toBe(1);
    expect(dry.json().will_refuse).toBe(0);
    const live = await importUpsert(manager.token, false);
    expect(live.statusCode, live.body).toBeLessThan(300);
    expect(live.json().updated).toBe(1);
    expect((await row(victim))[await fieldId('scopes')]).toEqual([scopeIds['admin']]);
  });

  it('MUST KEEP: a write a person approved still applies for an agent origin (the approvals marker), and still does not cover Tools or Model', async () => {
    const records = app.get(RecordsService);
    const { runWithEventOrigin } = await import('../src/common/credential-context');
    const origin = { agentId: boundAgentId, agentName: 'x', runId: null, runnerId: runner.id, runnerName: 'Test machine' };
    await runWithEventOrigin(origin, () => asApprovedAgentWrite(() => records.update(ws, agentsDbId, victim, { target_databases: 'Ledger' }, manager.id, 0, 'agent', boundAgentId, 'x')));
    expect((await row(victim))[await fieldId('target_databases')]).toBe('Ledger');
    await expect(runWithEventOrigin(origin, () => asApprovedAgentWrite(() => records.update(ws, agentsDbId, victim, { target_databases: 'Ledger', tools: 'x' }, manager.id, 0, 'agent', boundAgentId, 'x')))).rejects.toThrow(/cannot change an agent/);
  });
});
