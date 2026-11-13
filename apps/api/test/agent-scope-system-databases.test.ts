import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { MembersDbService } from '../src/members/members-db.service';

/**
 * ticket #1296 — a whole-space grant covers a space's USER databases only. The Members projection (every colleague's email,
 * ADR-0017) and the other system databases live in ordinary spaces ("General" holds Members), so before this ticket an agent
 * given a whole space reached them like any other database in it.
 *
 * Each assertion is made on the RUNTIME (the agent's credential against the real routes), not only on the scope endpoint, and
 * every refusal is checked on the response BODY too: a refusal must not carry what is on the other side. Identity is the
 * `is_system` flag, never the name: a person's own database called "Members" must stay in scope.
 *
 * Fixtures: an ADMIN, a MEMBER who manages the agents, a GUEST who owns one (only guests can have partial access, so a test
 * without one proves nothing), a Runner for the claim payload, and agent credentials minted both ways (a minted agent token and
 * the per-run credential a claimed wake hands over).
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let admin: { token: string };
let manager: Person;
let guest: Person;
let runner: { token: string; id: string };
let aiOwn = '';
let scopeIds: Record<string, string> = {};
let general = '', otherSpace = '';
let ledger = '', lookalike = '', membersDb = '', elsewhere = '';
let memberRecord = '';
let adminEmail = '';
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;

async function mkAgent(name: string, extra: Record<string, unknown>): Promise<string> {
  const res = await as(manager.token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** An agent-origin token for `agent`, minted by the admin (an admin may mint for any agent). Its authority is the agent OWNER's. */
async function mintFor(agent: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/me/tokens', { name: `agent ${agent.slice(0, 4)}`, workspace_id: ws, scope: 'write', agent_id: agent });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

type ScopeDb = { id: string; name: string; via: string };
type Claimed = { credential: { token: string }; agent: { scope: { enforced: boolean; databases: ScopeDb[]; unresolved: string[] } } };
async function claimFor(agent: string): Promise<Claimed> {
  const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ledger}/records`, { values: { name: `T ${agent.slice(0, 4)}` } })).json().id as string;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const res = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().wakes[0] as Claimed;
}
async function assign(agent: string) {
  expect((await as(manager.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id })).statusCode).toBe(200);
}

/** POST /records/query answers 201; `answered` is the one place that fact lives. */
const answered = (res: { statusCode: number }) => res.statusCode >= 200 && res.statusCode < 300;
const query = (token: string, db: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 50 });
const create = (token: string, db: string, name: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } });
const scopeOf = async (agent: string) => (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json() as { enforced: boolean; databases: ScopeDb[]; withheld_count: number };

/** Every way a credential could read or write the Members projection, asserted refused with no email in the body. */
async function expectMembersClosed(token: string, label: string) {
  const attempts = [
    await query(token, membersDb),
    await as(token, 'GET', `/workspaces/${ws}/databases/${membersDb}/records/${memberRecord}`),
    await create(token, membersDb, 'smuggled colleague'),
    await as(token, 'PATCH', `/workspaces/${ws}/databases/${membersDb}/records/${memberRecord}`, { values: { name: 'renamed by an agent' } }),
    await as(token, 'DELETE', `/workspaces/${ws}/databases/${membersDb}/records/${memberRecord}`),
  ];
  for (const [i, res] of attempts.entries()) {
    expect(res.statusCode, `${label} attempt ${i}: ${res.body}`).toBeGreaterThanOrEqual(403);
    expect(res.body, `${label} attempt ${i} leaked`).not.toContain(adminEmail);
    expect(res.body).not.toContain('renamed by an agent');
  }
  const row = await pool.query('select title, deleted_at from records where id = $1', [memberRecord]);
  expect(row.rows[0].deleted_at, `${label}: the Members row was deleted`).toBeNull();
  expect(row.rows[0].title, `${label}: the Members row was renamed`).not.toBe('renamed by an agent');
  const smuggled = await pool.query("select 1 from records where database_id = $1 and title = 'smuggled colleague'", [membersDb]);
  expect(smuggled.rows.length, `${label}: a record was written into Members`).toBe(0);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SysScopeAdmin');
  const me = (await as(admin.token, 'GET', '/me')).json();
  adminEmail = me.email as string;
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'System scope WS' })).json().id;
  general = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');

  otherSpace = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Other' })).json().id as string;
  const mkDb = async (space: string, name: string) => (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  ledger = await mkDb(general, 'Ledger');
  // A person's own database that happens to be called "Members": identity is the flag, so this one is a USER database.
  lookalike = await mkDb(general, 'Members');
  elsewhere = await mkDb(otherSpace, 'Elsewhere');
  membersDb = (await app.get(MembersDbService).ensureMembersDb(ws)).id;
  const members = await pool.query('select is_system, space_id from databases where id = $1', [membersDb]);
  expect(members.rows[0]).toMatchObject({ is_system: true, space_id: general }); // the fact the whole ticket rests on

  manager = await joinAs(app, admin.token, ws, 'SysScopeManager', 'member');
  guest = await joinAs(app, admin.token, ws, 'SysScopeGuest', 'guest', [{ space_id: general, role: 'editor' }]);

  const rows = await pool.query('select id from records where database_id = $1 and deleted_at is null order by created_at limit 1', [membersDb]);
  memberRecord = rows.rows[0]?.id as string;
  expect(memberRecord, 'the Members projection has rows').toBeTruthy();
  await create(admin.token, lookalike, 'My own list entry');

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

describe('#1296 a whole-space grant never reaches a system database', () => {
  let agent = '';
  let minted = '';

  it('the scope endpoint lists the space\'s user databases and no system database, and says nothing was withheld', async () => {
    agent = await mkAgent('General worker', { target_spaces: 'General' });
    const scope = await scopeOf(agent);
    expect(scope.enforced).toBe(true);
    const ids = scope.databases.map((d) => d.id);
    expect(ids).toContain(ledger);
    expect(ids).toContain(lookalike); // MUST KEEP: a user database named "Members" is a user database
    expect(ids).not.toContain(membersDb);
    const systemIds = (await pool.query('select id from databases where workspace_id = $1 and is_system', [ws])).rows.map((r: { id: string }) => r.id);
    expect(ids.filter((id) => systemIds.includes(id))).toEqual([]);
    expect(scope.withheld_count).toBe(0);
  });

  it('RUNTIME: a minted agent token cannot read, write, rename or delete anything in Members', async () => {
    minted = await mintFor(agent);
    await expectMembersClosed(minted, 'minted agent token');
  });

  it('RUNTIME: the Runner\'s per-run credential cannot either, and the claim payload lists the same databases as the endpoint', async () => {
    const runAgent = await mkAgent('General runner', { target_spaces: 'General' });
    await assign(runAgent);
    const claimed = await claimFor(runAgent);
    await expectMembersClosed(claimed.credential.token, 'run credential');
    const endpoint = (await scopeOf(runAgent)).databases.map((d) => d.id).sort();
    expect(claimed.agent.scope.databases.map((d) => d.id).sort()).toEqual(endpoint);
    expect(endpoint).not.toContain(membersDb);
  });

  it('RUNTIME: it cannot list Members among the databases, find a colleague by search, or see them through a relation', async () => {
    const dbs = await as(minted, 'GET', `/workspaces/${ws}/databases`);
    expect(dbs.statusCode, dbs.body).toBeLessThan(300);
    expect(JSON.stringify(dbs.json())).not.toContain(membersDb);
    const found = await as(minted, 'GET', `/workspaces/${ws}/search?q=${encodeURIComponent(adminEmail.split('@')[0]!)}`);
    expect(found.body).not.toContain(adminEmail);
    expect(found.body).not.toContain(memberRecord);
  });

  it('MUST KEEP: every USER database of the space is still read AND written, one created after the hire included', async () => {
    expect(answered(await query(minted, ledger))).toBe(true);
    expect((await create(minted, ledger, 'agent wrote this')).statusCode).toBe(201);
    const own = await query(minted, lookalike);
    expect(answered(own), own.body).toBe(true);
    expect(own.body).toContain('My own list entry');
    expect((await create(minted, lookalike, 'agent added to the lookalike')).statusCode).toBe(201);
    const later = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Added later' })).json().id as string;
    expect((await create(minted, later, 'in the new database')).statusCode).toBe(201);
    expect((await scopeOf(agent)).databases.map((d) => d.name)).toContain('Added later');
  });

  it('MUST KEEP: a database outside the space is still refused', async () => {
    const r = await query(minted, elsewhere);
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(403);
    expect(r.body).not.toContain('Elsewhere');
  });
});

describe('#1296 naming a system database is the only way in', () => {
  it('MUST KEEP: a system database NAMED in "Target databases" is in scope (via: database) and reachable, beside the whole space', async () => {
    const agent = await mkAgent('Named members reader', { target_spaces: 'General', target_databases: membersDb });
    const scope = await scopeOf(agent);
    expect(scope.databases.find((d) => d.id === membersDb)?.via).toBe('database');
    expect(scope.databases.map((d) => d.id)).toContain(ledger);
    const token = await mintFor(agent);
    const read = await query(token, membersDb);
    expect(answered(read), read.body).toBe(true);
    expect(read.body).toContain(adminEmail);
    expect(answered(await query(token, ledger))).toBe(true);
    // and what it was not named for stays closed: it reaches Members and no OTHER system database in the space
    const others = (await pool.query('select id from databases where workspace_id = $1 and is_system and id <> $2', [ws, membersDb])).rows.map((r: { id: string }) => r.id);
    for (const id of others) expect((await query(token, id)).statusCode, `system database ${id}`).toBeGreaterThanOrEqual(403);
  });

  it('naming a system database does not widen the space: an agent with only that name is unchanged (its target list is its brief)', async () => {
    const agent = await mkAgent('Name only', { target_databases: membersDb });
    const scope = await scopeOf(agent);
    expect(scope.enforced).toBe(false);
    expect(scope.databases.map((d) => d.id)).toEqual([membersDb]);
  });
});

describe('#1296 an agent owned by a GUEST', () => {
  it('holding a space grant, the guest\'s agent gets the space\'s user databases and not Members', async () => {
    const agent = await mkAgent('Guest-owned', { target_spaces: 'General' });
    await pool.query('update records set created_by = $1 where id = $2', [guest.id, agent]); // the owner is the record's creator
    const scope = await scopeOf(agent);
    expect(scope.databases.map((d) => d.id)).toContain(ledger);
    expect(scope.databases.map((d) => d.id)).not.toContain(membersDb);
    const token = await mintFor(agent);
    expect(answered(await query(token, ledger))).toBe(true);
    expect((await create(token, ledger, 'guest agent wrote this')).statusCode).toBe(201);
    await expectMembersClosed(token, 'guest-owned agent');
  });
});
