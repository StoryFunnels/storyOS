import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { MembersDbService } from '../src/members/members-db.service';

/**
 * tickets #1330 / #1331 — what the one access check enforces for two kinds of caller:
 *
 *  - an agent whose scope is a list of DATABASES (no target space): its credential reaches exactly the databases it names, and never
 *    a system database (Members, the Agents pack) it does not name, nor anything in another space;
 *  - a GUEST: whatever space, database or record grant a guest holds, a system database stays closed to them.
 *
 * Every read the product has is probed, because the rule lives in AccessService and the surfaces only inherit it. Each probe is
 * ALSO run by the owner, as a control: a probe that answers 404 for the wrong reason (a mistyped route) would otherwise pass as
 * "refused". Every refusal is checked on the response BODY too: it must not carry what is on the other side.
 *
 * Fixtures: an ADMIN, a MEMBER who manages agents, and GUESTS (viewer, editor, database-grant, record-grant): only guests can have
 * partial access, so a test without one proves nothing.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let admin: { token: string };
let manager: Person;
let guestViewer: Person, guestEditor: Person, guestDbGrant: Person, guestRecordGrant: Person, guestLedgerOnly: Person;
let runner: { token: string; id: string };
let aiOwn = '';
let scopeIds: Record<string, string> = {};
let general = '', otherSpace = '';
let ledger = '', lookalike = '', membersDb = '', elsewhere = '';
let memberRecord = '', ledgerRecord = '', elsewhereRecord = '';
let adminEmail = '';
const MARKER = 'Marker agent for leak checks';
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;
const answered = (res: { statusCode: number }) => res.statusCode >= 200 && res.statusCode < 300;
const query = (token: string, db: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 50 });
const create = (token: string, db: string, name: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } });
const scopeOf = async (agent: string) => (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json() as { enforced: boolean; databases: Array<{ id: string; name: string; via: string }>; withheld_count: number };

async function mkAgent(owner: string, name: string, extra: Record<string, unknown>): Promise<string> {
  const res = await as(owner, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mintFor(agent: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/me/tokens', { name: `agent ${agent.slice(0, 4)}`, workspace_id: ws, scope: 'write', agent_id: agent });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}
type Claimed = { credential: { token: string } };
async function claimFor(agent: string): Promise<Claimed> {
  expect((await as(manager.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id })).statusCode).toBe(200);
  const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ledger}/records`, { values: { name: `T ${agent.slice(0, 4)}` } })).json().id as string;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const res = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().wakes[0] as Claimed;
}

/** Every READ the product offers on one database / record. Each is run by the owner first (control), then by the caller under test. */
const readProbes = (db: string, rec: string): Array<[string, string, string, unknown?]> => [
  ['query', 'POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 50 }],
  ['count', 'POST', `/workspaces/${ws}/databases/${db}/records/aggregate`, { op: 'count' }],
  ['list', 'GET', `/workspaces/${ws}/databases/${db}/records`],
  ['get record', 'GET', `/workspaces/${ws}/databases/${db}/records/${rec}`],
  ['comments', 'GET', `/workspaces/${ws}/databases/${db}/records/${rec}/comments`],
  ['activity', 'GET', `/workspaces/${ws}/databases/${db}/records/${rec}/activity`],
  ['backlinks', 'GET', `/workspaces/${ws}/databases/${db}/records/${rec}/backlinks`],
  ['attachments', 'GET', `/workspaces/${ws}/databases/${db}/records/${rec}/attachments`],
  ['describe', 'GET', `/workspaces/${ws}/databases/${db}`],
  ['trash', 'GET', `/workspaces/${ws}/databases/${db}/records/trash`],
  ['views trash', 'GET', `/workspaces/${ws}/databases/${db}/views/trash`],
  ['csv export', 'GET', `/workspaces/${ws}/databases/${db}/export/csv`],
  ['database activity', 'GET', `/workspaces/${ws}/databases/${db}/activity/comments`],
];
const writeProbes = (db: string, rec: string): Array<[string, string, string, unknown?]> => [
  ['create', 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'smuggled colleague' } }],
  ['patch', 'PATCH', `/workspaces/${ws}/databases/${db}/records/${rec}`, { values: { name: 'renamed by a caller' } }],
  ['comment', 'POST', `/workspaces/${ws}/databases/${db}/records/${rec}/comments`, { body: [{ type: 'text', text: 'smuggled comment' }] }],
  ['delete', 'DELETE', `/workspaces/${ws}/databases/${db}/records/${rec}`],
];

/** The owner reads every probe (so none is a mistyped route), then `token` is refused on each, with nothing of the far side in the body. */
async function expectClosed(token: string, label: string, db: string, rec: string, secrets: string[]) {
  for (const [name, method, url, body] of readProbes(db, rec)) {
    const control = await as(admin.token, method, url, body);
    expect(answered(control), `control ${name} (a mistyped route would pass as "refused"): ${control.statusCode} ${control.body.slice(0, 200)}`).toBe(true);
    const res = await as(token, method, url, body);
    expect(res.statusCode, `${label} ${name}: ${res.body.slice(0, 300)}`).toBeGreaterThanOrEqual(403);
    for (const s of secrets) expect(res.body, `${label} ${name} leaked ${s}`).not.toContain(s);
  }
  for (const [name, method, url, body] of writeProbes(db, rec)) {
    const res = await as(token, method, url, body);
    expect(res.statusCode, `${label} ${name}: ${res.body.slice(0, 300)}`).toBeGreaterThanOrEqual(403);
  }
  const row = await pool.query('select title, deleted_at from records where id = $1', [rec]);
  expect(row.rows[0].deleted_at, `${label}: the row was deleted`).toBeNull();
  expect(row.rows[0].title, `${label}: the row was renamed`).not.toBe('renamed by a caller');
  const smuggled = await pool.query("select 1 from records where database_id = $1 and title = 'smuggled colleague'", [db]);
  expect(smuggled.rows.length, `${label}: a record was written`).toBe(0);
  const comments = await pool.query("select 1 from comments where body::text like '%smuggled comment%'");
  expect(comments.rows.length, `${label}: a comment was written`).toBe(0);
}
/** The list-shaped reads that name no database: the database list, global search and the "recent" feed. */
async function expectNotListed(token: string, label: string, hidden: string[], secrets: string[]) {
  const dbs = await as(token, 'GET', `/workspaces/${ws}/databases`);
  expect(dbs.statusCode, dbs.body).toBeLessThan(300);
  for (const id of hidden) expect(JSON.stringify(dbs.json()), `${label}: database ${id} listed`).not.toContain(id);
  for (const url of [`/workspaces/${ws}/search?q=${encodeURIComponent(adminEmail.split('@')[0]!)}`, `/workspaces/${ws}/search?q=${MARKER.split(' ')[0]}`, `/workspaces/${ws}/recent`]) {
    const res = await as(token, 'GET', url);
    for (const s of secrets) expect(res.body, `${label} ${url} leaked ${s}`).not.toContain(s);
  }
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'AccChkAdmin');
  adminEmail = (await as(admin.token, 'GET', '/me')).json().email as string;
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Access check WS' })).json().id;
  general = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');

  otherSpace = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Other' })).json().id as string;
  const mkDb = async (space: string, name: string) => (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  ledger = await mkDb(general, 'Ledger');
  lookalike = await mkDb(general, 'Members'); // a person's own database called "Members": identity is the flag, so this is a USER database
  elsewhere = await mkDb(otherSpace, 'Elsewhere');
  membersDb = (await app.get(MembersDbService).ensureMembersDb(ws)).id;
  expect((await pool.query('select is_system, space_id from databases where id = $1', [membersDb])).rows[0]).toMatchObject({ is_system: true, space_id: general });

  manager = await joinAs(app, admin.token, ws, 'AccChkManager', 'member');
  guestViewer = await joinAs(app, admin.token, ws, 'AccChkGuestViewer', 'guest', [{ space_id: general, role: 'viewer' }]);
  guestEditor = await joinAs(app, admin.token, ws, 'AccChkGuestEditor', 'guest', [{ space_id: general, role: 'editor' }]);
  guestDbGrant = await joinAs(app, admin.token, ws, 'AccChkGuestDb', 'guest', [{ space_id: general, role: 'viewer' }]);
  guestRecordGrant = await joinAs(app, admin.token, ws, 'AccChkGuestRec', 'guest', [{ space_id: general, role: 'viewer' }]);
  guestLedgerOnly = await joinAs(app, admin.token, ws, 'AccChkGuestLedger', 'guest', [{ database_id: ledger, role: 'editor' }]);

  memberRecord = (await pool.query('select id from records where database_id = $1 and deleted_at is null order by created_at limit 1', [membersDb])).rows[0]?.id as string;
  expect(memberRecord, 'the Members projection has rows').toBeTruthy();
  ledgerRecord = (await create(admin.token, ledger, 'Ledger entry')).json().id as string;
  elsewhereRecord = (await create(admin.token, elsewhere, 'Elsewhere entry')).json().id as string;
  await create(admin.token, lookalike, 'My own list entry');
  await mkAgent(admin.token, MARKER, {}); // a row in the Agents pack that must stay unreadable

  // Grants placed ON the system database / one of its records: a guest must not reach it by either.
  const g1 = await as(admin.token, 'POST', `/workspaces/${ws}/grants`, { user_id: guestDbGrant.id, database_id: membersDb, role: 'editor' });
  expect(g1.statusCode, g1.body).toBeLessThan(300);
  const g2 = await as(admin.token, 'POST', `/workspaces/${ws}/grants`, { user_id: guestRecordGrant.id, record_id: memberRecord, role: 'editor' });
  expect(g2.statusCode, g2.body).toBeLessThan(300);

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

describe('#1330 an agent scoped to specific databases', () => {
  let ledgerAgent = '';
  let minted = '';
  const secrets = () => [adminEmail, MARKER, 'Elsewhere entry'];

  it('the scope endpoint says the scope is enforced and lists exactly the named databases', async () => {
    ledgerAgent = await mkAgent(manager.token, 'Ledger worker', { target_databases: 'Ledger' });
    const scope = await scopeOf(ledgerAgent);
    expect(scope.enforced).toBe(true);
    expect(scope.databases.map((d) => d.id)).toEqual([ledger]);
  });

  it('RUNTIME: a minted agent token (member owner) is refused Members, the Agents pack and a database in another space, on every read and write', async () => {
    minted = await mintFor(ledgerAgent);
    await expectClosed(minted, 'minted token / Members', membersDb, memberRecord, secrets());
    await expectClosed(minted, 'minted token / Agents', agentsDbId, (await pool.query('select id from records where database_id = $1 limit 1', [agentsDbId])).rows[0].id as string, secrets());
    await expectClosed(minted, 'minted token / other space', elsewhere, elsewhereRecord, secrets());
  });

  it('RUNTIME: it is also refused a user database of ITS OWN space that it does not name (a scope names databases, not the space around them)', async () => {
    const res = await query(minted, lookalike);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(403);
    expect(res.body).not.toContain('My own list entry');
  });

  it('RUNTIME: an agent owned by an ADMIN is bound the same way (the admin fast path does not apply to its credential)', async () => {
    const adminAgent = await mkAgent(admin.token, 'Admin-owned ledger worker', { target_databases: 'Ledger' });
    const token = await mintFor(adminAgent);
    await expectClosed(token, 'admin-owned agent / Members', membersDb, memberRecord, secrets());
    await expectClosed(token, 'admin-owned agent / other space', elsewhere, elsewhereRecord, secrets());
    expect(answered(await query(token, ledger))).toBe(true);
  });

  it("RUNTIME: the Runner's per-run credential is bound the same way", async () => {
    const runAgent = await mkAgent(manager.token, 'Ledger runner', { target_databases: 'Ledger' });
    const claimed = await claimFor(runAgent);
    await expectClosed(claimed.credential.token, 'run credential / Members', membersDb, memberRecord, secrets());
    await expectClosed(claimed.credential.token, 'run credential / other space', elsewhere, elsewhereRecord, secrets());
    expect(answered(await query(claimed.credential.token, ledger))).toBe(true);
  });

  it('RUNTIME: it cannot list Members, the Agents pack or another space\'s database, and search finds nothing of them', async () => {
    await expectNotListed(minted, 'database-scoped agent', [membersDb, agentsDbId, elsewhere, lookalike], secrets());
  });

  it('MUST KEEP: its named database is read and written, and the scope endpoint still answers for it', async () => {
    const own = await query(minted, ledger);
    expect(answered(own), own.body).toBe(true);
    expect(own.body).toContain('Ledger entry');
    expect((await create(minted, ledger, 'agent wrote this')).statusCode).toBe(201);
    expect((await as(minted, 'GET', `/workspaces/${ws}/databases/${ledger}/records/${ledgerRecord}`)).statusCode).toBe(200);
    expect(JSON.stringify((await as(minted, 'GET', `/workspaces/${ws}/databases`)).json())).toContain(ledger);
  });

  it('MUST KEEP: several named databases, across spaces, are all reachable and nothing else is', async () => {
    const agent = await mkAgent(manager.token, 'Two-space worker', { target_databases: 'Ledger, Elsewhere' });
    const token = await mintFor(agent);
    expect(answered(await query(token, ledger))).toBe(true);
    expect(answered(await query(token, elsewhere))).toBe(true);
    expect((await query(token, membersDb)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await query(token, lookalike)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('MUST KEEP: a system database NAMED in "Target databases" stays reachable, and no other system database is', async () => {
    const agent = await mkAgent(manager.token, 'Named members reader', { target_databases: `Ledger, ${membersDb}` });
    const token = await mintFor(agent);
    const read = await query(token, membersDb);
    expect(answered(read), read.body).toBe(true);
    expect(read.body).toContain(adminEmail);
    expect(answered(await query(token, ledger))).toBe(true);
    const others = (await pool.query('select id from databases where workspace_id = $1 and is_system and id <> $2', [ws, membersDb])).rows.map((r: { id: string }) => r.id);
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) expect((await query(token, id)).statusCode, `system database ${id}`).toBeGreaterThanOrEqual(403);
  });

  it('MUST KEEP: a user database literally called "Members" is reachable when it is the one named', async () => {
    const agent = await mkAgent(manager.token, 'Lookalike worker', { target_databases: lookalike });
    const token = await mintFor(agent);
    const read = await query(token, lookalike);
    expect(answered(read), read.body).toBe(true);
    expect(read.body).toContain('My own list entry');
    expect((await query(token, membersDb)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('a database named by the agent that does not exist fails CLOSED: the agent reaches nothing, and the scope says why', async () => {
    const agent = await mkAgent(manager.token, 'Typo worker', { target_databases: 'Ledgr' });
    const scope = await scopeOf(agent);
    expect(scope.enforced).toBe(true);
    expect(scope.databases).toEqual([]);
    const token = await mintFor(agent);
    for (const db of [ledger, membersDb, elsewhere]) expect((await query(token, db)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('whole-space agents and agents with no target at all behave as before', async () => {
    const wholeSpace = await mkAgent(manager.token, 'General worker', { target_spaces: 'General' });
    const token = await mintFor(wholeSpace);
    expect(answered(await query(token, ledger))).toBe(true);
    expect(answered(await query(token, lookalike))).toBe(true);
    expect((await query(token, membersDb)).statusCode).toBeGreaterThanOrEqual(403);
    const scopeless = await mkAgent(manager.token, 'No scope', {});
    expect((await scopeOf(scopeless)).enforced).toBe(false);
  });
});

describe('#1331 a guest never reaches a system database', () => {
  const secrets = () => [adminEmail, MARKER, 'Elsewhere entry'];

  for (const [label, who] of [
    ['viewer on the space', () => guestViewer],
    ['editor on the space', () => guestEditor],
    ['holder of a grant ON the Members database', () => guestDbGrant],
    ['holder of a grant on a Members RECORD', () => guestRecordGrant],
  ] as const) {
    it(`a guest who is ${label} is refused Members and the Agents pack on every read and write`, async () => {
      const token = who().token;
      await expectClosed(token, `${label} / Members`, membersDb, memberRecord, secrets());
      await expectClosed(token, `${label} / Agents`, agentsDbId, (await pool.query('select id from records where database_id = $1 limit 1', [agentsDbId])).rows[0].id as string, secrets());
    });
  }

  it('a guest cannot list the system databases, or find a colleague or an agent by search', async () => {
    for (const g of [guestViewer, guestEditor, guestDbGrant, guestRecordGrant]) {
      await expectNotListed(g.token, g.email, [membersDb, agentsDbId], secrets());
    }
  });

  it('no relation chip, backlink or "my work" row shows a guest a system database\'s records', async () => {
    for (const g of [guestViewer, guestDbGrant, guestRecordGrant]) {
      const work = await as(g.token, 'GET', `/workspaces/${ws}/my-work`);
      expect(work.body).not.toContain(adminEmail);
      expect(work.body).not.toContain(memberRecord);
    }
  });

  it('MUST KEEP: the granted space still works: the guest sees it, reads its user databases, and an editor writes them', async () => {
    const spaces = await as(guestViewer.token, 'GET', `/workspaces/${ws}/spaces`);
    expect(JSON.stringify(spaces.json())).toContain(general);
    expect(JSON.stringify((await as(guestViewer.token, 'GET', `/workspaces/${ws}/databases`)).json())).toContain(ledger);
    for (const g of [guestViewer, guestEditor, guestDbGrant, guestRecordGrant]) {
      const read = await query(g.token, ledger);
      expect(answered(read), `${g.email}: ${read.body}`).toBe(true);
      expect(read.body).toContain('Ledger entry');
    }
    expect((await create(guestEditor.token, ledger, 'guest editor wrote this')).statusCode).toBe(201);
    expect((await create(guestViewer.token, ledger, 'viewer must not write')).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('MUST KEEP: a user database literally called "Members" in the granted space stays readable, and another space stays closed', async () => {
    const own = await query(guestViewer.token, lookalike);
    expect(answered(own), own.body).toBe(true);
    expect(own.body).toContain('My own list entry');
    expect((await query(guestViewer.token, elsewhere)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('MUST KEEP: a guest with a grant on one database reads that database and still not Members', async () => {
    expect(answered(await query(guestLedgerOnly.token, ledger))).toBe(true);
    expect((await create(guestLedgerOnly.token, ledger, 'ledger-only guest wrote this')).statusCode).toBe(201);
    await expectClosed(guestLedgerOnly.token, 'ledger-only guest / Members', membersDb, memberRecord, secrets());
  });

  it('MUST KEEP: members and admins reach Members exactly as before, and it is listed for them', async () => {
    for (const token of [admin.token, manager.token]) {
      const read = await query(token, membersDb);
      expect(answered(read), read.body).toBe(true);
      expect(read.body).toContain(adminEmail);
      expect(JSON.stringify((await as(token, 'GET', `/workspaces/${ws}/databases`)).json())).toContain(membersDb);
    }
  });

  it('an agent owned by a GUEST that names Members is still refused it (a guest never reaches a system database, named or not)', async () => {
    const agent = await mkAgent(admin.token, 'Guest-owned', { target_databases: `Ledger, ${membersDb}` });
    await pool.query('update records set created_by = $1 where id = $2', [guestEditor.id, agent]); // the owner is the record's creator
    const token = await mintFor(agent);
    expect(answered(await query(token, ledger))).toBe(true);
    await expectClosed(token, 'guest-owned agent / Members', membersDb, memberRecord, secrets());
  });
});
