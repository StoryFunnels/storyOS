import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { DB } from '../src/db/db.module';
import { AccessService } from '../src/access/access.service';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';
import { presentAuditRecords } from '../src/activity/audit-record-presenter';
import { activityEvents, databases, memberships, records, selectOptions, spaces } from '../src/db/schema';
import type { Membership } from '../src/workspaces/workspace-access.guard';

/**
 * Ticket #1287 - an audit-log row about a record NAMES it: {id, number, title, database_id, database_name, deleted, withheld}.
 * The gate is the shared access rule (effectiveForRecords + canSeePersonal), asserted three ways: what an admin must KEEP seeing,
 * what each kind of reader must NOT be told (restricted database, a record they hold no grant on, another member's personal space),
 * and that a deleted record or database still renders instead of erroring. Readers other than an admin cannot reach the endpoint (403),
 * so their rejections are asserted on the presenter the endpoint calls, with a real membership row.
 */
const { db: testDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let guest: { token: string; email: string };
let ws: string;
let space: string;
let dbId: string;
let memberUserId: string;
let access: AccessService;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

interface Named { id: string; number: number | null; title: string | null; database_id: string | null; database_name: string | null; deleted: boolean; withheld: boolean }
interface Row { kind: string; payload?: unknown; actor_name?: string; created_at?: string; type?: string; record_id: string | null; record: Named | null; field?: string }
const audit = async (query = '') => {
  const res = await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return { rows: res.json().data as Row[], raw: res.body };
};
const rowsFor = async (recordId: string) => (await audit(`&entity=${recordId}`)).rows;
const newRecord = async (database: string, title: string, token = admin.token) => {
  const r = await as(token, 'POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name: title } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; number: number; title: string };
};
const mkDb = async (spaceId: string, name: string) => {
  const d = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name })).json().id as string;
  return d;
};
const membershipOf = async (userId: string) =>
  (await testDb.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, ws), eq(memberships.userId, userId)) }))! as Membership;
const meId = async (token: string) => (await as(token, 'GET', '/me')).json().id as string;

beforeAll(async () => {
  app = await createTestApp();
  access = app.get(AccessService);
  admin = await signUpUser(app, 'Names Admin');
  member = await signUpUser(app, 'Names Member');
  guest = await signUpUser(app, 'Names Guest');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Names WS' })).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = await mkDb(space, 'Work');
  const inv = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, { email: member.email, role: 'member' });
  await as(member.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  memberUserId = await meId(member.token);
  await app.get(MembersProjectionSubscriber).settle(ws);
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('#1287 what an admin must KEEP seeing: the record, named', () => {
  it('a create row AND a field-change row name the record: number, title, database id and name', async () => {
    const rec = await newRecord(dbId, 'Quarterly budget review');
    const rows = await rowsFor(rec.id);
    expect(rows.some((r) => r.kind === 'event')).toBe(true);
    for (const r of rows) {
      expect(r.record, JSON.stringify(r)).toEqual({ id: rec.id, number: rec.number, title: 'Quarterly budget review', database_id: dbId, database_name: 'Work', deleted: false, withheld: false });
    }
    expect(rec.number, 'the number is the record public number, not nothing').toBeGreaterThan(0);
  });

  it('a rename is read at the next request (nothing stored on the audit row to go stale)', async () => {
    const rec = await newRecord(dbId, 'Old name');
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${dbId}/records/${rec.id}`, { values: { name: 'New name' } });
    expect((await rowsFor(rec.id)).every((r) => r.record?.title === 'New name')).toBe(true);
  });

  it('a row with no record (a structural event) carries record: null, not an error', async () => {
    const d = await mkDb(space, 'Throwaway');
    await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${d}`, { confirm: 'Throwaway' });
    const structural = (await audit(`&type=database.deleted&entity=${d}`)).rows.filter((r) => r.type === 'database.deleted');
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.every((r) => r.record_id === null && r.record === null)).toBe(true);
  });

  it('an admin reads a SYSTEM database record by the same rule (is_system does not change who may read)', async () => {
    const sys = await mkDb(space, 'System-ish');
    await testDb.update(databases).set({ isSystem: true }).where(eq(databases.id, sys));
    const rec = await newRecord(sys, 'Row in a system database');
    expect((await rowsFor(rec.id))[0]!.record).toMatchObject({ title: 'Row in a system database', database_name: 'System-ish', withheld: false });
  });
});

describe('#1287 a deleted record or database still renders - never an error', () => {
  it('a deleted RECORD: deleted true, still named for the admin who may read that database', async () => {
    const rec = await newRecord(dbId, 'Doomed record');
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${dbId}/records/${rec.id}`)).statusCode).toBeLessThan(300);
    const rows = await rowsFor(rec.id);
    expect(rows.length).toBeGreaterThan(1); // the create and the delete
    expect(rows.every((r) => r.record?.deleted === true && r.record.withheld === false && r.record.title === 'Doomed record')).toBe(true);
  });

  it('a record in a deleted DATABASE: deleted true, database name kept', async () => {
    const d = await mkDb(space, 'Doomed database');
    const rec = await newRecord(d, 'Lives in a doomed database');
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${d}`, { confirm: 'Doomed database' })).statusCode).toBe(200);
    expect((await rowsFor(rec.id))[0]!.record).toMatchObject({ deleted: true, withheld: false, database_name: 'Doomed database', database_id: d });
  });

  it('a database or space soft-deleted WITHOUT the record row being flagged still reads deleted (the record row alone is not the source of truth)', async () => {
    const d = await mkDb(space, 'Flag only');
    const rec = await newRecord(d, 'Unflagged record');
    await testDb.update(databases).set({ deletedAt: new Date() }).where(eq(databases.id, d));
    expect((await rowsFor(rec.id))[0]!.record).toMatchObject({ deleted: true, title: 'Unflagged record' });
    const s2 = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Flag-only space' })).json().id as string;
    const d2 = await mkDb(s2, 'In a flagged space');
    const rec2 = await newRecord(d2, 'Record in flagged space');
    await testDb.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, s2));
    expect((await rowsFor(rec2.id))[0]!.record).toMatchObject({ deleted: true, database_name: 'In a flagged space' });
  });

  it('a record id with no row at all reads deleted with every name null (unreachable over HTTP: events cascade with the record)', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000aa';
    const out = await presentAuditRecords(testDb, access, await membershipOf(await meId(admin.token)), [ghost]);
    expect(out.get(ghost)).toEqual({ id: ghost, number: null, title: null, database_id: null, database_name: null, deleted: true, withheld: false });
  });
});

describe('#1287 what a reader must NOT be told (REJECTIONS)', () => {
  it("ANOTHER member's personal space: the admin log carries the id only - the title and the database name are nowhere in the body", async () => {
    // A personal space holds no databases through the API (#1173); a row from before that rule is the case this guards, so it is placed directly.
    const pSpace = (await as(member.token, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id as string;
    const pDb = await mkDb(space, 'Private Lens DB');
    const rec = await newRecord(pDb, 'Dentist appointment, private');
    await testDb.update(databases).set({ spaceId: pSpace }).where(eq(databases.id, pDb));
    const { rows, raw } = await audit(`&entity=${rec.id}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.record, 'admin is NOT the owner').toEqual({ id: rec.id, number: null, title: null, database_id: null, database_name: null, deleted: false, withheld: true });
    expect(raw, 'not through the event payload (record.created carries the title) nor the field-change values').not.toContain('Dentist appointment');
    expect(rows.every((r) => r.payload === undefined || Object.keys(r.payload as object).length === 0)).toBe(true);
    // MUST KEEP: who and when survive the redaction - the row is still a row
    expect(rows.every((r) => r.actor_name === 'Names Admin' && r.created_at)).toBe(true);
    expect(raw).not.toContain('Private Lens DB');
    // MUST KEEP: its owner is not shut out of their own space
    const own = await presentAuditRecords(testDb, access, await membershipOf(memberUserId), [rec.id]);
    expect(own.get(rec.id)).toMatchObject({ title: 'Dentist appointment, private', withheld: false });
  });

  it('a RESTRICTED database: a member holding no grant is withheld; an admin is not', async () => {
    const d = await mkDb(space, 'Board papers');
    const rec = await newRecord(d, 'Acquisition terms');
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${d}`, { restricted: true })).statusCode).toBe(200);
    const m = await presentAuditRecords(testDb, access, await membershipOf(memberUserId), [rec.id]);
    expect(m.get(rec.id)).toEqual({ id: rec.id, number: null, title: null, database_id: null, database_name: null, deleted: false, withheld: true });
    expect((await rowsFor(rec.id))[0]!.record).toMatchObject({ title: 'Acquisition terms', withheld: false });
    // MUST KEEP: a member on an OPEN database is still told
    const open = await newRecord(dbId, 'Open record');
    expect((await presentAuditRecords(testDb, access, await membershipOf(memberUserId), [open.id])).get(open.id)).toMatchObject({ title: 'Open record', withheld: false });
  });

  it('a GUEST sees only what a grant reaches: space grant yes, other space no, one record grant names that record only', async () => {
    const clientSpace = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Client Work' })).json().id as string;
    const clientDb = await mkDb(clientSpace, 'Client Tasks');
    const clientRec = await newRecord(clientDb, 'Client deliverable');
    const internal = await newRecord(dbId, 'Internal only');
    const grantedOne = await newRecord(dbId, 'The one shared record');
    const inv = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, {
      email: guest.email, role: 'guest', grants: [{ space_id: clientSpace, role: 'viewer' }, { record_id: grantedOne.id, role: 'viewer' }],
    });
    await as(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const g = await presentAuditRecords(testDb, access, await membershipOf(await meId(guest.token)), [clientRec.id, internal.id, grantedOne.id]);
    expect(g.get(clientRec.id), 'KEEP: the space the guest holds').toMatchObject({ title: 'Client deliverable', database_name: 'Client Tasks', withheld: false });
    expect(g.get(internal.id), 'REJECT: an open internal database the guest holds nothing on').toMatchObject({ title: null, database_name: null, database_id: null, withheld: true });
    expect(g.get(grantedOne.id), 'KEEP: a record the guest holds a grant on').toMatchObject({ title: 'The one shared record', withheld: false });
    // and the endpoint itself stays closed to a guest and to a member: the presenter is the second lock, not the first
    expect((await as(guest.token, 'GET', `/workspaces/${ws}/audit-log`)).statusCode).toBe(403);
    expect((await as(member.token, 'GET', `/workspaces/${ws}/audit-log`)).statusCode).toBe(403);
  });

  it('a non-admin reads the title WITHOUT cross-record inputs (#884 titleLocal), an admin reads the full title', async () => {
    const rec = await newRecord(dbId, 'Alpha - full of lookup data');
    await testDb.update(records).set({ titleLocal: 'Alpha - —' }).where(eq(records.id, rec.id));
    expect((await presentAuditRecords(testDb, access, await membershipOf(memberUserId), [rec.id])).get(rec.id)!.title).toBe('Alpha - —');
    expect((await rowsFor(rec.id))[0]!.record!.title).toBe('Alpha - full of lookup data');
  });
});

describe('#1287 no N+1: the number of SQL statements does not grow with the rows', () => {
  async function count(fn: () => Promise<unknown>): Promise<number> {
    const poolClient = (app.get(DB) as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
    const original = poolClient.query.bind(poolClient);
    let n = 0;
    poolClient.query = (...args: unknown[]) => { n += 1; return original(...args); };
    try { await fn(); } finally { poolClient.query = original; }
    return n;
  }

  it('the audit log read costs the same for 3 rows as for 60, across many databases', async () => {
    for (let i = 0; i < 8; i += 1) {
      const d = await mkDb(space, `Spread ${i}`);
      for (let j = 0; j < 4; j += 1) await newRecord(d, `Spread ${i}.${j}`);
    }
    const few = await count(async () => { expect((await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=3`)).statusCode).toBe(200); });
    const many = await count(async () => { expect((await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100`)).json().data.length).toBeGreaterThan(40); });
    expect(many, `3 rows cost ${few} statements; 100 rows must cost the same`).toBe(few);
  });

  it('the guest path is one grants fetch, not one per record', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push((await newRecord(dbId, `Guest batch ${i}`)).id);
    const guestMembership = await membershipOf(await meId(guest.token));
    const few = await count(() => presentAuditRecords(testDb, access, guestMembership, ids.slice(0, 2)));
    const many = await count(() => presentAuditRecords(testDb, access, guestMembership, ids));
    expect(many).toBe(few);
    // the admin path touches no grants table at all: exactly the one resolution read
    expect(await count(() => presentAuditRecords(testDb, access, null as never, []))).toBe(0);
  });
});


describe('#1287 (widened) resolved display data sits ALONGSIDE the raw ids', () => {
  it('select / multi-select: old_display and new_display are option labels; the raw ids stay in old_value / new_value; a deleted option never prints its id', async () => {
    const d = await mkDb(space, 'Pipeline');
    const st = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${d}/fields`, { display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'Lead' }, { label: 'Won' }] })).json();
    const tags = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${d}/fields`, { display_name: 'Tags', type: 'multi_select', config: {}, options: [{ label: 'Hot' }, { label: 'Cold' }] })).json();
    const [lead, won] = st.options as Array<{ id: string; label: string }>;
    const [hot, cold] = tags.options as Array<{ id: string }>;
    const rec = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${d}/records`, { values: { name: 'Deal', [st.apiName]: lead!.id } })).json();
    const upd = await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${d}/records/${rec.id}`, { values: { [st.apiName]: won!.id, [tags.apiName]: [hot!.id, cold!.id] } });
    expect(upd.statusCode, upd.body).toBeLessThan(300);
    const rows = (await rowsFor(rec.id)) as Array<Row & { field_type?: string; old_value?: unknown; new_value?: unknown; old_display?: unknown; new_display?: unknown }>;
    const stage = rows.find((r) => r.field === 'Stage' && r.new_value === won!.id)!;
    expect(stage, JSON.stringify(rows)).toMatchObject({ field_type: 'select', old_value: lead!.id, old_display: 'Lead', new_display: 'Won' });
    expect(rows.find((r) => r.field === 'Tags')).toMatchObject({ field_type: 'multi_select', new_value: [hot!.id, cold!.id], new_display: ['Hot', 'Cold'] });
    // an option removed since: the label is gone but the row never prints a bare id
    await testDb.delete(selectOptions).where(eq(selectOptions.id, lead!.id));
    const after = ((await rowsFor(rec.id)) as Array<Row & { old_value?: unknown; old_display?: unknown }>).find((r) => r.field === 'Stage' && r.old_value === lead!.id)!;
    expect(after.old_display).toBe('(deleted option)');
  });

  it('relation: the linked record is named (title, number, database) and gated by the same rule; a withheld one carries no title anywhere', async () => {
    const a = await mkDb(space, 'Projects');
    const b = await mkDb(space, 'Clients');
    const rel = await as(admin.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: a, database_b_id: b, cardinality: 'many_to_many', field_a_name: 'Client', field_b_name: 'Projects' });
    expect(rel.statusCode, rel.body).toBe(201);
    const project = await newRecord(a, 'Site redesign');
    const client = await newRecord(b, 'Acme Corp');
    const hidden = await newRecord(b, 'Stealth Client Ltd');
    for (const target of [client, hidden]) {
      const l = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${a}/records/${project.id}/links/${rel.json().field_a.id}`, { record_ids: [target.id] });
      expect(l.statusCode, l.body).toBe(201);
    }
    const pSpace = (await as(member.token, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id as string;
    await testDb.update(databases).set({ spaceId: pSpace }).where(eq(databases.id, b)); // Clients is now a legacy row in someone's personal space
    const { rows, raw } = await audit(`&entity=${project.id}`);
    const linked = rows.filter((r) => r.type === 'relation.linked') as Array<Row & { other_record?: Named; payload?: { other?: { id: string; title?: string } } }>;
    expect(linked.length).toBeGreaterThanOrEqual(2);
    for (const l of linked) {
      expect(l.other_record, 'REJECT: the other record lives in another member\'s personal space').toEqual({ id: l.payload!.other!.id, number: null, title: null, database_id: null, database_name: null, deleted: false, withheld: true });
      expect(l.payload!.other!.title, 'nor through the write-time snapshot in the payload').toBeUndefined();
    }
    expect(raw).not.toContain('Acme Corp');
    expect(raw).not.toContain('Stealth Client');
    // MUST KEEP: with the database back in a shared space the linked record is named
    await testDb.update(databases).set({ spaceId: space }).where(eq(databases.id, b));
    const back = ((await audit(`&entity=${project.id}`)).rows.filter((r) => r.type === 'relation.linked') as Array<Row & { other_record?: Named }>).map((r) => r.other_record!);
    expect(back.map((o) => o.title).sort()).toEqual(['Acme Corp', 'Stealth Client Ltd']);
    expect(back[0]).toMatchObject({ database_name: 'Clients', database_id: b, withheld: false });
  });

  it('actor: a member is named; a removed member is named with actor_removed; the Members sync is a system actor, not a removed member', async () => {
    await testDb.insert(activityEvents).values({ workspaceId: ws, recordId: null, actorId: 'system:members-projection', type: 'database.restored', payload: {}, source: 'automation' });
    await testDb.insert(activityEvents).values({ workspaceId: ws, recordId: null, actorId: 'user-who-never-existed', type: 'database.restored', payload: {}, source: 'human' });
    const rows = (await audit('&type=database.restored')).rows as Array<Row & { actor_id?: string; actor_name?: string; actor_kind?: string; actor_removed?: boolean }>;
    expect(rows.find((r) => r.actor_id === 'system:members-projection')).toMatchObject({ actor_name: 'Members sync', actor_kind: 'system', actor_removed: false });
    const gone = rows.find((r) => r.actor_id === 'user-who-never-existed')!;
    expect(gone).toMatchObject({ actor_name: 'A former member', actor_kind: 'member', actor_removed: true });
    const rec = await newRecord(dbId, 'Made by an admin who stays');
    expect((await rowsFor(rec.id))[0]).toMatchObject({ actor_name: 'Names Admin', actor_kind: 'member', actor_removed: false });
    // no row's display name is an auth id
    for (const r of (await audit()).rows as Array<Row & { actor_id?: string; actor_name?: string }>) if (r.actor_id) expect(r.actor_name).not.toBe(r.actor_id);
  });
});
