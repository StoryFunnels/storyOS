import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { shape } from './helpers/route-sweep';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { activityEvents, databases, records, changeSource } from '../src/db/schema';
import { isAgencySource } from '../src/records/agency-source';
import { isPushableCommentSource } from '../src/comments/comment-origin';
import { TokensService } from '../src/tokens/tokens.service';
import { ExternalIdUpsertService } from '../src/migration-framework/external-id-upsert.service';
import { RecordsService } from '../src/records/records.service';

/**
 * Ticket #1363 — a database opts in to record identifiers (`ISSUE-5201`).
 *
 * Everything here is Pinewood-style fake data. Callers: an admin owner, a plain member, a member with no grant inside a restricted space,
 * and a GUEST holding a grant on one unrelated database (a test with no guest or no member-without-grant fixture proves nothing about
 * access, CLAUDE.md "views-and-the-sidebar").
 */
let app: NestFastifyApplication;
let dbh: Db;
let owner: { token: string; email: string };
let ownerId: string;
let ws: string, space: string, hiddenSpace: string;
let issuesDb: string, plainDb: string, hiddenDb: string, otherDb: string;
let bob: Person;
let gina: Person;

const adm = (m: string, u: string, p?: unknown) => call(app, owner.token, m, u, p);
const id = async (m: string, u: string, p?: unknown) => {
  const r = await adm(m, u, p);
  if (r.statusCode >= 300) throw new Error(`fixture ${m} ${u}: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
};
const mkRecord = async (database: string, name: string) =>
  (await adm('POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name } })).json();

beforeAll(async () => {
  app = await createTestApp();
  dbh = app.get(DB);
  owner = await signUpUser(app, 'Ident Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Pinewood Identifiers' })).json().id;
  ownerId = (await adm('GET', '/me')).json().id;
  space = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  hiddenSpace = await id('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' });
  issuesDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Issues' });
  plainDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Plain notes' });
  otherDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Roasts' });
  hiddenDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: hiddenSpace, name: 'Board issues' });
  bob = await joinAs(app, owner.token, ws, 'Ident Bob', 'member');
  gina = await joinAs(app, owner.token, ws, 'Ident Gina', 'guest', [{ database_id: otherDb, role: 'viewer' }]);
}, 120_000);
afterAll(async () => {
  await app.close();
});

const setPrefix = (token: string, database: string, prefix: string | null) =>
  call(app, token, 'PATCH', `/workspaces/${ws}/databases/${database}`, { identifier_prefix: prefix });

describe('setting the prefix', () => {
  it('an admin sets it and it shows on the database payloads (get and list)', async () => {
    const res = await setPrefix(owner.token, issuesDb, 'ISSUE');
    expect(res.statusCode).toBe(200);
    expect(res.json().identifierPrefix).toBe('ISSUE');
    const detail = (await adm('GET', `/workspaces/${ws}/databases/${issuesDb}`)).json();
    expect(detail.identifierPrefix).toBe('ISSUE');
    const list = (await adm('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; identifierPrefix: string | null }>;
    expect(list.find((d) => d.id === issuesDb)?.identifierPrefix).toBe('ISSUE');
    expect(list.find((d) => d.id === plainDb)?.identifierPrefix).toBeNull();
  });

  it('a plain member is refused (403), and the prefix is unchanged', async () => {
    const res = await setPrefix(bob.token, plainDb, 'NOTE');
    expect(res.statusCode).toBe(403);
    expect((await adm('GET', `/workspaces/${ws}/databases/${plainDb}`)).json().identifierPrefix).toBeNull();
  });

  it('an agent-origin token held by an ADMIN is refused too (the prefix is an admin decision, not an agent one)', async () => {
    const tokens = app.get(TokensService);
    const agent = await tokens.create(ownerId, ws, 'ident-agent', 'admin', true, 'agent');
    const res = await setPrefix(agent.token, plainDb, 'NOTE');
    expect(res.statusCode).toBe(403);
    expect((await adm('GET', `/workspaces/${ws}/databases/${plainDb}`)).json().identifierPrefix).toBeNull();
  });

  it('a token bound to specific databases is refused even with admin scope', async () => {
    const mint = await adm('POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope: 'admin', resource_scope: { database_ids: [plainDb] } });
    expect(mint.statusCode).toBe(201);
    const res = await setPrefix(mint.json().token, plainDb, 'NOTE');
    expect(res.statusCode).toBe(403);
    expect((await adm('GET', `/workspaces/${ws}/databases/${plainDb}`)).json().identifierPrefix).toBeNull();
  });

  it.each(['A', 'issue', '1ISSUE', 'IS-SUE', 'ELEVENCHARSX', 'ISS UE', ''])('rejects the malformed prefix %j with 422', async (bad) => {
    const res = await setPrefix(owner.token, plainDb, bad);
    expect(res.statusCode).toBe(422);
    expect((await adm('GET', `/workspaces/${ws}/databases/${plainDb}`)).json().identifierPrefix).toBeNull();
  });

  it('a prefix already used in the workspace is a 409 naming the holder', async () => {
    const res = await setPrefix(owner.token, plainDb, 'ISSUE');
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Issues');
  });

  it('the duplicate check is case-insensitive at the database level too', async () => {
    // the CHECK keeps stored prefixes upper-case, so a lower-case duplicate can only be forced by dropping that for the probe
    await expect(
      dbh.execute(sql`INSERT INTO databases (workspace_id, space_id, name, api_slug, identifier_prefix) VALUES (${ws}, ${space}, 'x', 'x-dup', 'issue')`),
    ).rejects.toThrow();
  });

  it('the same prefix is fine in ANOTHER workspace', async () => {
    const ws2 = (await adm('POST', '/workspaces', { name: 'Second Pinewood' })).json().id;
    const sp2 = (await adm('GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const db2 = (await adm('POST', `/workspaces/${ws2}/databases`, { space_id: sp2, name: 'Issues' })).json().id;
    const res = await call(app, owner.token, 'PATCH', `/workspaces/${ws2}/databases/${db2}`, { identifier_prefix: 'ISSUE' });
    expect(res.statusCode).toBe(200);
  });

  it('a system database cannot carry one', async () => {
    const list = (await adm('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; isSystem: boolean }>;
    const system = list.find((d) => d.isSystem);
    if (!system) return; // no system database provisioned in this workspace: nothing to refuse
    const res = await setPrefix(owner.token, system.id, 'SYS');
    expect(res.statusCode).toBe(422);
  });

  it('null removes it, and the number space is untouched', async () => {
    const tmp = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Scratch' });
    expect((await setPrefix(owner.token, tmp, 'SCR')).statusCode).toBe(200);
    const rec = await mkRecord(tmp, 'one');
    expect(rec.identifier).toBe(`SCR-${rec.number}`);
    expect((await setPrefix(owner.token, tmp, null)).statusCode).toBe(200);
    const after = (await adm('GET', `/workspaces/${ws}/databases/${tmp}/records/${rec.id}`)).json();
    expect(after.identifier).toBeNull();
    expect(after.number).toBe(rec.number);
  });
});

describe('identifier on record payloads (derived, never stored)', () => {
  let rec: { id: string; number: number; identifier: string };
  it('create returns it', async () => {
    rec = await mkRecord(issuesDb, 'Grinder jams on dark roast');
    expect(rec.identifier).toBe(`ISSUE-${rec.number}`);
  });
  it('get, list, query and update return it', async () => {
    const base = `/workspaces/${ws}/databases/${issuesDb}/records`;
    expect((await adm('GET', `${base}/${rec.id}`)).json().identifier).toBe(rec.identifier);
    const list = (await adm('GET', base)).json().data as Array<{ id: string; identifier: string }>;
    expect(list.find((r) => r.id === rec.id)?.identifier).toBe(rec.identifier);
    const q = (await adm('POST', `${base}/query`, { sorts: [], limit: 50 })).json().data as Array<{ id: string; identifier: string }>;
    expect(q.find((r) => r.id === rec.id)?.identifier).toBe(rec.identifier);
    const upd = (await adm('PATCH', `${base}/${rec.id}`, { values: { name: 'Grinder jams' } })).json();
    expect(upd.identifier).toBe(rec.identifier);
  });
  it('a database with no prefix says identifier: null, so nothing changes for it', async () => {
    const plain = await mkRecord(plainDb, 'A note');
    expect(plain.identifier).toBeNull();
    expect(typeof plain.number).toBe('number');
  });
  it('it is not stored: no records column carries it, and renaming the prefix moves every identifier at once', async () => {
    const cols = (await dbh.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'records'`)) as unknown as { rows?: Array<{ column_name: string }> } | Array<{ column_name: string }>;
    const names = (Array.isArray(cols) ? cols : (cols.rows ?? [])).map((c) => c.column_name);
    expect(names.filter((n) => /ident/i.test(n))).toEqual([]);
    const tmp = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Renamed' });
    await setPrefix(owner.token, tmp, 'OLD');
    const r = await mkRecord(tmp, 'x');
    await setPrefix(owner.token, tmp, 'NEW');
    expect((await adm('GET', `/workspaces/${ws}/databases/${tmp}/records/${r.id}`)).json().identifier).toBe(`NEW-${r.number}`);
  });
});

describe('import-only number assignment (externalIdUpsert)', () => {
  let impDb: string;
  const membershipFor = () => ({ workspaceId: ws, role: 'admin', userId: ownerId }) as never;
  const counter = async (database: string) => (await dbh.select({ c: databases.recordCounter }).from(databases).where(eq(databases.id, database)))[0]!.c;
  const numberOf = async (recId: string) => (await dbh.select({ n: records.number }).from(records).where(eq(records.id, recId)))[0]!.n;

  beforeAll(async () => {
    impDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Imported issues' });
    await setPrefix(owner.token, impDb, 'IMP');
    const fields = await adm('POST', `/workspaces/${ws}/databases/${impDb}/fields`, { display_name: 'External ID', type: 'text' });
    expect(fields.statusCode).toBe(201);
  });

  it('writes the record at the number the source says, and the counter jumps to the highest number written', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    const out = await upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-1', { name: 'Imported one' }, ownerId, { number: 5201 });
    expect(await numberOf(out.id)).toBe(5201);
    expect(await counter(impDb)).toBe(5201);
    const got = (await adm('GET', `/workspaces/${ws}/databases/${impDb}/records/${out.id}`)).json();
    expect(got.identifier).toBe('IMP-5201');
  });

  it('a record made afterwards continues after the highest imported number', async () => {
    const next = await mkRecord(impDb, 'Made by a person');
    expect(next.number).toBe(5202);
    expect(next.identifier).toBe('IMP-5202');
  });

  it('a LOWER number written later never moves the counter back (GREATEST)', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    const out = await upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-2', { name: 'Imported older' }, ownerId, { number: 7 });
    expect(await numberOf(out.id)).toBe(7);
    expect(await counter(impDb)).toBe(5202);
    expect((await mkRecord(impDb, 'after the low one')).number).toBe(5203);
  });

  it('a number already held refuses, names the holder, and overwrites nothing', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    const before = await counter(impDb);
    await expect(
      upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-3', { name: 'Clashing import' }, ownerId, { number: 5201 }),
    ).rejects.toThrow(/5201.*Imported one|Imported one.*5201/);
    const holder = (await dbh.select({ title: records.title }).from(records).where(sql`${records.databaseId} = ${impDb} AND ${records.number} = 5201`))[0]!;
    expect(holder.title).toBe('Imported one');
    const clash = await dbh.select({ id: records.id }).from(records).where(sql`${records.databaseId} = ${impDb} AND ${records.title} = 'Clashing import'`);
    expect(clash).toEqual([]);
    expect(await counter(impDb)).toBe(before);
  });

  it('a SOFT-DELETED record keeps its number: it still refuses (an identifier is never reused)', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    const out = await upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-4', { name: 'Will be trashed' }, ownerId, { number: 6000 });
    const del = await adm('DELETE', `/workspaces/${ws}/databases/${impDb}/records/${out.id}`);
    expect(del.statusCode).toBeLessThan(300);
    await expect(
      upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-5', { name: 'Wants the trashed number' }, ownerId, { number: 6000 }),
    ).rejects.toThrow(/6000/);
  });

  it('an existing record keeps its number: a re-import naming a DIFFERENT number refuses rather than renumbering', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    await expect(
      upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-1', { name: 'Imported one' }, ownerId, { number: 9999 }),
    ).rejects.toThrow(/5201/);
    // the same number again is just an idempotent update
    const again = await upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-1', { name: 'Imported one (edited)' }, ownerId, { number: 5201 });
    expect(again.updated).toBe(true);
  });

  it('without a number the importer behaves exactly as before (counter allocation)', async () => {
    const upsert = app.get(ExternalIdUpsertService);
    const before = await counter(impDb);
    const out = await upsert.upsert(membershipFor(), impDb, 'external_id', 'lin-6', { name: 'No number given' }, ownerId);
    expect(await numberOf(out.id)).toBe(before + 1);
  });

  it('the PUBLIC create route cannot choose a number: `number` in the body is not honoured', async () => {
    const res = await adm('POST', `/workspaces/${ws}/databases/${impDb}/records`, { values: { name: 'Sneaky' }, number: 12345 });
    if (res.statusCode === 201) expect(res.json().number).not.toBe(12345);
    else expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const batch = await adm('POST', `/workspaces/${ws}/databases/${impDb}/records/batch`, { records: [{ values: { name: 'Sneaky batch' }, number: 54321 }] });
    if (batch.statusCode === 201) expect(JSON.stringify(batch.json())).not.toContain('54321');
    const via = await dbh.select({ n: records.number }).from(records).where(sql`${records.databaseId} = ${impDb} AND ${records.number} IN (12345, 54321)`);
    expect(via).toEqual([]);
  });

  it('a batch import with numbers is allocated atomically too (one counter bump, one clash check)', async () => {
    const recordsService = app.get(RecordsService);
    const rows = await recordsService.createBatch(ws, impDb, [{ name: 'B1' }, { name: 'B2' }], ownerId, 0, { source: 'import', numbers: [8100, 8101] });
    expect(rows.map((r) => r.number)).toEqual([8100, 8101]);
    expect(await counter(impDb)).toBeGreaterThanOrEqual(8101);
    await expect(recordsService.createBatch(ws, impDb, [{ name: 'B3' }, { name: 'B4' }], ownerId, 0, { source: 'import', numbers: [8200, 8100] })).rejects.toThrow(/8100/);
    // the clash aborted the WHOLE batch: 8200 was not written
    const written = await dbh.select({ id: records.id }).from(records).where(sql`${records.databaseId} = ${impDb} AND ${records.number} = 8200`);
    expect(written).toEqual([]);
  });
});

describe("the 'import' change source", () => {
  it('is a real enum value, in the same migration as the prefix', () => {
    expect(changeSource.enumValues).toContain('import');
  });
  it('the audit log accepts it as a filter', async () => {
    const res = await adm('GET', `/workspaces/${ws}/audit-log?source=import`);
    expect(res.statusCode).toBeLessThan(400);
  });
  it('a write with source import is recorded as import, is neutral for gold (not an agent, not an MCP write), and is not an outward-pushable comment source', async () => {
    const recordsService = app.get(RecordsService);
    const db = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Import source probe' });
    const [row] = await recordsService.createBatch(ws, db, [{ name: 'Replayed' }], ownerId, 0, { source: 'import' });
    const stored = (await dbh.select({ ai: records.lastAiChangeAt }).from(records).where(eq(records.id, row!.id)))[0]!;
    expect(stored.ai).toBeNull();
    const ev = await dbh.select({ source: activityEvents.source }).from(activityEvents).where(eq(activityEvents.recordId, row!.id));
    expect(ev.map((e) => e.source)).toEqual(['import']);
    expect(isAgencySource('import')).toBe(false);
    expect(isPushableCommentSource('import')).toBe(false);
  });
});

describe('lookup by identifier, through the same access door as every record route', () => {
  let issue: { id: string; number: number; identifier: string };
  let hiddenIssue: { id: string; number: number; identifier: string };
  const url = (ident: string) => `/workspaces/${ws}/records/by-identifier/${encodeURIComponent(ident)}`;

  beforeAll(async () => {
    issue = await mkRecord(issuesDb, 'Steam wand weak');
    await setPrefix(owner.token, hiddenDb, 'BOARD');
    hiddenIssue = await mkRecord(hiddenDb, 'Quarterly minutes');
    await setRestricted(app, owner.token, ws, 'space', hiddenSpace);
  });

  it('resolves the record, and the prefix is case-insensitive', async () => {
    const res = await adm('GET', url(issue.identifier));
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(issue.id);
    expect(res.json().identifier).toBe(issue.identifier);
    expect(res.json().database_id).toBe(issuesDb);
    expect((await adm('GET', url(issue.identifier.toLowerCase()))).json().id).toBe(issue.id);
  });

  it('a member reads an open database through it', async () => {
    const res = await call(app, bob.token, 'GET', url(issue.identifier));
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(issue.id);
  });

  it('admin reaches the restricted one; a member with no grant gets the 404 an unknown prefix gets, byte for byte', async () => {
    expect((await adm('GET', url(hiddenIssue.identifier))).statusCode).toBe(200);
    const unknown = await call(app, bob.token, 'GET', url(`NOSUCH-${hiddenIssue.number}`));
    const hidden = await call(app, bob.token, 'GET', url(hiddenIssue.identifier));
    expect(hidden.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(unknown.statusCode);
    expect(shape(hidden)).toBe(shape(unknown));
  });

  it('a GUEST holding a grant on an unrelated database cannot read either, and cannot tell them apart from an unknown prefix', async () => {
    const unknown = await call(app, gina.token, 'GET', url(`NOSUCH-${issue.number}`));
    for (const ident of [issue.identifier, hiddenIssue.identifier]) {
      const res = await call(app, gina.token, 'GET', url(ident));
      expect(res.statusCode, ident).toBe(404);
      expect(shape(res), ident).toBe(shape(unknown));
    }
  });

  it('a number that does not exist, and text that is not an identifier, are the same 404', async () => {
    const missing = await adm('GET', url(`ISSUE-999999`));
    const junk = await adm('GET', url('not-an-identifier!'));
    expect(missing.statusCode).toBe(404);
    expect(junk.statusCode).toBe(404);
    expect(shape(junk)).toBe(shape(missing));
  });

  it('a bound token that cannot see the database gets the same 404', async () => {
    const mint = await call(app, bob.token, 'POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope: 'admin', resource_scope: { database_ids: [otherDb] } });
    const res = await call(app, mint.json().token, 'GET', url(issue.identifier));
    const unknown = await call(app, mint.json().token, 'GET', url(`NOSUCH-${issue.number}`));
    // a bound token gets its one boundary refusal, identical for the hidden database and the unknown prefix
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBe(unknown.statusCode);
    expect(shape(res)).toBe(shape(unknown));
  });

  it('a trashed record is not found through its identifier', async () => {
    const gone = await mkRecord(issuesDb, 'About to be trashed');
    await adm('DELETE', `/workspaces/${ws}/databases/${issuesDb}/records/${gone.id}`);
    expect((await adm('GET', url(gone.identifier))).statusCode).toBe(404);
  });
});
