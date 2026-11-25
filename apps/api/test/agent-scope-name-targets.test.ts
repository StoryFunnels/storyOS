import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { MembersDbService } from '../src/members/members-db.service';
import { PACK_REGISTRY } from '../src/packs/registry';
import type { PackManifest } from '@storyos/schemas';

/**
 * ticket #1335 — a NAME in an agent's "Target databases" is a request for a USER database, and it binds only what it unambiguously
 * names. Two holes in the resolver, each found by probing a live agent credential:
 *   1. a name that spells a system database ("Members") also bound the system Members projection (every colleague's email), because
 *      the resolver matched names against every database including system ones;
 *   2. a name bound EVERY database of that name in EVERY non-personal space, including ones created later.
 *
 * Rules under test (and written down in agent-scope.ts):
 *   - a system database is bound by its id only, never by its name (an id is a deliberate act; a name is a coincidence);
 *   - a name resolves inside the agent's own target spaces first; with no hit there it binds when exactly ONE database carries it, and
 *     binds NOTHING when several do (fail closed: the manager names the one they mean by id, and the scope lists the entry as
 *     unresolved so the manager can see why).
 *
 * Every refusal is asserted on the RUNTIME credential and on the response BODY, not only on the scope endpoint. The agents here carry a
 * `target_spaces` so the credential is bound whichever way database-only agents are treated.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let admin: { token: string };
let manager: Person;
let aiOwn = '';
let scopeIds: Record<string, string> = {};
let general = '', other = '';
let membersDb = '', userMembers = '', memberRecord = '', adminEmail = '';
let tasksGeneral = '', tasksOther = '', soloOther = '';
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;
const answered = (res: { statusCode: number }) => res.statusCode >= 200 && res.statusCode < 300;
const query = (token: string, db: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 50 });
const create = (token: string, db: string, name: string) => as(token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } });
const mkDb = async (space: string, name: string) => (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;

async function mkAgent(name: string, extra: Record<string, unknown>): Promise<string> {
  const res = await as(manager.token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mintFor(agent: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/me/tokens', { name: `agent ${agent.slice(0, 4)}`, workspace_id: ws, scope: 'write', agent_id: agent });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}
type ScopeDb = { id: string; name: string; via: string };
const scopeOf = async (agent: string) =>
  (await as(admin.token, 'GET', `/workspaces/${ws}/agents/${agent}/scope`)).json() as { enforced: boolean; databases: ScopeDb[]; unresolved: string[] };

async function expectMembersClosed(token: string, label: string) {
  const attempts = [
    await query(token, membersDb),
    await as(token, 'GET', `/workspaces/${ws}/databases/${membersDb}/records/${memberRecord}`),
    await create(token, membersDb, 'smuggled colleague'),
  ];
  for (const [i, res] of attempts.entries()) {
    expect(res.statusCode, `${label} attempt ${i}: ${res.body}`).toBeGreaterThanOrEqual(403);
    expect(res.body, `${label} attempt ${i} leaked`).not.toContain(adminEmail);
  }
  const smuggled = await pool.query("select 1 from records where database_id = $1 and title = 'smuggled colleague'", [membersDb]);
  expect(smuggled.rows.length, `${label}: a record was written into Members`).toBe(0);
}
async function expectClosed(token: string, db: string, secret: string, label: string) {
  for (const res of [await query(token, db), await create(token, db, 'smuggled')]) {
    expect(res.statusCode, `${label}: ${res.body}`).toBeGreaterThanOrEqual(403);
    expect(res.body, `${label} leaked`).not.toContain(secret);
  }
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'NameTargetAdmin');
  adminEmail = (await as(admin.token, 'GET', '/me')).json().email as string;
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Name target WS' })).json().id;
  general = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries(
      (await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map(
        (r: { label: string; id: string }) => [r.label, r.id],
      ),
    );
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');

  other = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Other' })).json().id as string;
  await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Quiet' }); // holds nothing: an agent that targets it is bound, and reaches only what its names add
  membersDb = (await app.get(MembersDbService).ensureMembersDb(ws)).id;
  expect((await pool.query('select is_system from databases where id = $1', [membersDb])).rows[0].is_system).toBe(true);
  userMembers = await mkDb(other, 'Members'); // a person's own database that happens to share the system database's name
  tasksGeneral = await mkDb(general, 'Tasks');
  tasksOther = await mkDb(other, 'Tasks');
  soloOther = await mkDb(other, 'Solo');
  for (const [db, text] of [[userMembers, 'user members row'], [tasksGeneral, 'general task'], [tasksOther, 'other task'], [soloOther, 'solo row']] as const) await create(admin.token, db, text);
  memberRecord = (await pool.query('select id from records where database_id = $1 and deleted_at is null order by created_at limit 1', [membersDb])).rows[0]?.id as string;
  expect(memberRecord, 'the Members projection has rows').toBeTruthy();
  manager = await joinAs(app, admin.token, ws, 'NameTargetManager', 'member');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1335 a name never binds a system database', () => {
  it('"Members" binds the user database of that name and NOT the system Members projection (scope endpoint)', async () => {
    const agent = await mkAgent('Named Members', { target_spaces: 'Quiet', target_databases: 'Members' });
    const scope = await scopeOf(agent);
    expect(scope.enforced).toBe(true);
    const ids = scope.databases.map((d) => d.id);
    expect(ids).toContain(userMembers); // MUST KEEP: the person's own "Members" database is what the name meant
    expect(ids).not.toContain(membersDb);
  });

  it('RUNTIME: the credential reads the user database called "Members" and is refused the system one, with no email in the body', async () => {
    const agent = await mkAgent('Named Members 2', { target_spaces: 'Quiet', target_databases: 'Members' });
    const token = await mintFor(agent);
    const own = await query(token, userMembers);
    expect(answered(own), own.body).toBe(true);
    expect(own.body).toContain('user members row');
    await expectMembersClosed(token, 'name "Members"');
  });

  it('the name matches case-insensitively and with padding, and still never the system database', async () => {
    const agent = await mkAgent('Shouted Members', { target_spaces: 'Quiet', target_databases: ' MEMBERS ' });
    expect((await scopeOf(agent)).databases.map((d) => d.id)).not.toContain(membersDb);
    await expectMembersClosed(await mintFor(agent), 'name " MEMBERS "');
  });

  it('with no user database of that name, the name binds nothing and is listed as unresolved', async () => {
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${userMembers}`, { name: 'Renamed away' });
    try {
      const agent = await mkAgent('Only system by name', { target_spaces: 'Quiet', target_databases: 'Members' });
      const scope = await scopeOf(agent);
      expect(scope.databases.map((d) => d.id)).toEqual([]);
      expect(scope.unresolved).toEqual(['Members']);
      await expectMembersClosed(await mintFor(agent), 'name "Members", no user database');
    } finally {
      await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${userMembers}`, { name: 'Members' });
    }
  });

  it('MUST KEEP: the system database NAMED BY ID is still bound (naming one deliberately is the only way in)', async () => {
    const agent = await mkAgent('Id Members', { target_spaces: 'Quiet', target_databases: membersDb });
    const scope = await scopeOf(agent);
    expect(scope.databases.find((d) => d.id === membersDb)?.via).toBe('database');
    const read = await query(await mintFor(agent), membersDb);
    expect(answered(read), read.body).toBe(true);
    expect(read.body).toContain(adminEmail);
  });
});

describe('#1335 a name binds one database, not every database of that name', () => {
  it('inside the agent\'s own spaces the name resolves THERE: the same-named database in another space stays closed', async () => {
    const agent = await mkAgent('General tasks', { target_spaces: 'General', target_databases: 'Tasks' });
    const scope = await scopeOf(agent);
    expect(scope.databases.map((d) => d.id)).toContain(tasksGeneral);
    expect(scope.databases.map((d) => d.id)).not.toContain(tasksOther);
    expect(scope.unresolved, 'the name DID resolve, in the agent\'s own space').toEqual([]);
    const token = await mintFor(agent);
    expect(answered(await query(token, tasksGeneral))).toBe(true);
    await expectClosed(token, tasksOther, 'other task', 'same-named database in another space');
  });

  it('a name that two databases carry, neither in the agent\'s spaces, binds NEITHER and is listed as unresolved (fail closed)', async () => {
    const agent = await mkAgent('Ambiguous tasks', { target_spaces: 'Quiet', target_databases: 'Tasks' });
    const scope = await scopeOf(agent);
    expect(scope.databases).toEqual([]);
    expect(scope.unresolved).toEqual(['Tasks']);
    const token = await mintFor(agent);
    await expectClosed(token, tasksGeneral, 'general task', 'ambiguous name, first');
    await expectClosed(token, tasksOther, 'other task', 'ambiguous name, second');
  });

  it('a database created LATER with the same name does not join the scope', async () => {
    const agent = await mkAgent('Solo reader', { target_spaces: 'Quiet', target_databases: 'Solo' });
    expect((await scopeOf(agent)).databases.map((d) => d.id)).toEqual([soloOther]); // MUST KEEP: a unique name still binds
    const later = await mkDb(general, 'Solo');
    await create(admin.token, later, 'second solo');
    const scope = await scopeOf(agent);
    expect(scope.databases).toEqual([]);
    expect(scope.unresolved).toEqual(['Solo']);
    await expectClosed(await mintFor(agent), later, 'second solo', 'later same-named database');
  });

  it('MUST KEEP: a unique name outside the agent\'s spaces still binds, beside the space (the "named database plus a space" shape)', async () => {
    const unique = await mkDb(other, 'Unique Ledger');
    await create(admin.token, unique, 'unique row');
    const agent = await mkAgent('Space plus unique name', { target_spaces: 'Quiet', target_databases: 'Unique Ledger' });
    const scope = await scopeOf(agent);
    expect(scope.databases.map((d) => `${d.name}:${d.via}`)).toEqual(['Unique Ledger:database']);
    const token = await mintFor(agent);
    expect(answered(await query(token, unique))).toBe(true);
    expect((await create(token, unique, 'agent wrote')).statusCode).toBe(201);
  });

  it('MUST KEEP: an id still binds a database whatever else carries its name', async () => {
    const agent = await mkAgent('Tasks by id', { target_spaces: 'Quiet', target_databases: tasksOther });
    expect((await scopeOf(agent)).databases.map((d) => d.id)).toEqual([tasksOther]);
    expect(answered(await query(await mintFor(agent), tasksOther))).toBe(true);
  });

  it('a database-only agent (no target space) gets the same resolution in its scope listing', async () => {
    const agent = await mkAgent('Db only members', { target_databases: 'Members, Tasks' });
    const scope = await scopeOf(agent);
    expect(scope.databases.map((d) => d.id)).toEqual([userMembers]);
    expect(scope.unresolved).toEqual(['Tasks']);
    // RUNTIME: a database-only agent's credential is bound too (ticket #1330), so the same name cannot reach the Members projection
    const token = await mintFor(agent);
    expect(answered(await query(token, userMembers))).toBe(true);
    await expectMembersClosed(token, 'database-only agent, name "Members"');
    await expectClosed(token, tasksGeneral, 'general task', 'database-only agent, ambiguous name');
  });
});

describe('#1335 MUST KEEP: an agent a pack installs keeps working on the databases the pack built', () => {
  it('install pins the agent\'s target to the database id, so a later same-named database elsewhere cannot join it', async () => {
    const m = structuredClone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as PackManifest;
    m.slug = 'name-target-pack';
    m.agents = [...m.agents, { name: 'Ticket Reader', goal: 'Read tickets', scopes: ['read'], approval_policy: [], target_databases: ['Tickets'], skills: [] } as never];
    const wsPack = (await as(admin.token, 'POST', '/workspaces', { name: `Name target pack ${Date.now()}` })).json().id as string;
    const installed = await as(admin.token, 'POST', `/workspaces/${wsPack}/packs/install`, { manifest: m });
    expect(installed.statusCode, installed.body).toBe(201);
    const agent = (installed.json() as { agents: Array<{ name: string; id: string }> }).agents.find((a) => a.name === 'Ticket Reader')!;
    const tickets = ((await as(admin.token, 'GET', `/workspaces/${wsPack}/databases`)).json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Tickets')!;
    const stored = (await pool.query('select values from records where id = $1', [agent.id])).rows[0].values as Record<string, unknown>;
    expect(Object.values(stored).filter((v) => typeof v === 'string' && v.includes(tickets.id)), 'the stored target is the database id').not.toEqual([]);
    const scopeUrl = `/workspaces/${wsPack}/agents/${agent.id}/scope`;
    const scope = (await as(admin.token, 'GET', scopeUrl)).json() as { databases: ScopeDb[]; unresolved: string[] };
    expect(scope.databases.map((d) => d.id)).toEqual([tickets.id]);
    expect(scope.unresolved).toEqual([]);
    // a second "Tickets" in another space, created after the install, is not the pack agent's
    const elsewhere = (await as(admin.token, 'POST', `/workspaces/${wsPack}/spaces`, { name: 'Elsewhere' })).json().id as string;
    await as(admin.token, 'POST', `/workspaces/${wsPack}/databases`, { space_id: elsewhere, name: 'Tickets' });
    const after = (await as(admin.token, 'GET', scopeUrl)).json() as { databases: ScopeDb[]; unresolved: string[] };
    expect(after.databases.map((d) => d.id)).toEqual([tickets.id]);
    expect(after.unresolved).toEqual([]);
  }, 90_000);
});
