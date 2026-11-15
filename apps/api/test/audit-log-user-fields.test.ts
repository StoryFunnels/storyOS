import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { DB } from '../src/db/db.module';
import { AccessService } from '../src/access/access.service';
import { MembersDbService } from '../src/members/members-db.service';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';
import { presentAuditRecords } from '../src/activity/audit-record-presenter';
import { displayUserValue } from '../src/activity/audit-user-values';
import { memberships, recordFieldChanges } from '../src/db/schema';
import type { Membership } from '../src/workspaces/workspace-access.guard';

/**
 * Ticket #1287 (send-back) - a `user` field change names the PERSON in old_display / new_display, never the better-auth id.
 * Single and multi fields; a removed member; a person with no Members row; a system or agent id; and a person a GUEST may not read.
 * The raw old_value / new_value stay the stored ids (documented), so every display assertion also proves the id is absent from it.
 */
const { db: testDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ada: { token: string; email: string };
let bob: { token: string; email: string };
let guest: { token: string; email: string };
let ws: string;
let dbId: string;
let adaId: string;
let bobId: string;
let single: { apiName: string; id: string };
let multi: { apiName: string; id: string };

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const meId = async (token: string) => (await as(token, 'GET', '/me')).json().id as string;
const invite = async (who: { token: string; email: string }, role: string, grants?: unknown) => {
  const inv = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, { email: who.email, role, ...(grants ? { grants } : {}) });
  expect(inv.statusCode, inv.body).toBeLessThan(300);
  await as(who.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
};
const membershipOf = async (userId: string) =>
  (await testDb.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, ws), eq(memberships.userId, userId)) }))! as Membership;
const newRecord = async (title: string, values: Record<string, unknown> = {}) => {
  const r = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: title, ...values } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
};
const patch = async (recordId: string, values: Record<string, unknown>) => {
  const r = await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${dbId}/records/${recordId}`, { values });
  expect(r.statusCode, r.body).toBeLessThan(300);
};
interface UserRow { kind: string; field?: string; field_type?: string; old_value?: unknown; new_value?: unknown; old_display?: unknown; new_display?: unknown }
const changesFor = async (recordId: string, field: string) => {
  const res = await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100&entity=${recordId}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as UserRow[]).filter((r) => r.kind === 'field_change' && r.field === field);
};
const noRawIdIn = (row: UserRow, ...ids: string[]) => {
  const shown = JSON.stringify([row.old_display, row.new_display]);
  for (const id of ids) expect(shown, `a display field printed the auth id ${id}`).not.toContain(id);
};
const people = () => app.get(MembersDbService);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'People Admin');
  ada = await signUpUser(app, 'Ada Lovelace');
  bob = await signUpUser(app, 'Bob Barker');
  guest = await signUpUser(app, 'People Guest');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'People WS' })).json().id;
  const space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  await invite(ada, 'member');
  await invite(bob, 'member');
  adaId = await meId(ada.token);
  bobId = await meId(bob.token);
  await app.get(MembersProjectionSubscriber).settle(ws);
  const mk = async (name: string, config: object) => {
    const f = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/fields`, { display_name: name, type: 'user', config });
    expect(f.statusCode, f.body).toBe(201);
    return { apiName: f.json().apiName as string, id: f.json().id as string };
  };
  single = await mk('Assignee', {});
  multi = await mk('Reviewers', { multi: true });
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('#1287 a user field names the person, single and multi', () => {
  it('single: set, changed and CLEARED all read as names; the raw ids stay in old_value / new_value', async () => {
    const rec = await newRecord('Single assignee');
    await patch(rec.id, { [single.apiName]: adaId });
    await patch(rec.id, { [single.apiName]: bobId });
    await patch(rec.id, { [single.apiName]: null });
    const rows = await changesFor(rec.id, 'Assignee');
    const set = rows.find((r) => r.new_value === adaId)!;
    const swapped = rows.find((r) => r.old_value === adaId && r.new_value === bobId)!;
    const cleared = rows.find((r) => r.old_value === bobId && r.new_value == null)!;
    expect(set, JSON.stringify(rows)).toMatchObject({ field_type: 'user', new_display: 'Ada Lovelace' });
    expect(swapped).toMatchObject({ old_display: 'Ada Lovelace', new_display: 'Bob Barker' });
    expect(cleared, 'the send-back repro: an assignee set then cleared').toMatchObject({ old_display: 'Bob Barker', new_display: null });
    for (const r of [set, swapped, cleared]) noRawIdIn(r, adaId, bobId);
  });

  it('multi: a list of people reads as a list of names, in order', async () => {
    const rec = await newRecord('Two reviewers');
    await patch(rec.id, { [multi.apiName]: [adaId, bobId] });
    await patch(rec.id, { [multi.apiName]: [bobId] });
    const rows = await changesFor(rec.id, 'Reviewers');
    const both = rows.find((r) => Array.isArray(r.new_value) && r.new_value.length === 2)!;
    expect(both, JSON.stringify(rows)).toMatchObject({ field_type: 'user', new_value: [adaId, bobId], new_display: ['Ada Lovelace', 'Bob Barker'] });
    expect(rows.find((r) => Array.isArray(r.old_value) && r.old_value.length === 2)).toMatchObject({ old_display: ['Ada Lovelace', 'Bob Barker'], new_display: ['Bob Barker'] });
    for (const r of rows) noRawIdIn(r, adaId, bobId);
  });

  it('KEEP: select labels, text and numbers are exactly as before (this change touches only user fields)', async () => {
    const st = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/fields`, { display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'Lead' }, { label: 'Won' }] })).json();
    const rec = await newRecord('Keeps', { [st.apiName]: st.options[0].id });
    await patch(rec.id, { [st.apiName]: st.options[1].id, name: 'Keeps renamed' });
    const rows = (await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100&entity=${rec.id}`)).json().data as UserRow[];
    expect(rows.find((r) => r.field === 'Stage' && r.new_display === 'Won')).toMatchObject({ field_type: 'select', old_display: 'Lead' });
    expect(rows.find((r) => r.field === 'Name')).toMatchObject({ old_display: 'Keeps', new_display: 'Keeps renamed' });
  });
});

describe('#1287 a person who is not a current, visible member never prints as an id', () => {
  it('a removed member reads "A former member" (their Members row is tombstoned)', async () => {
    const carol = await signUpUser(app, 'Carol Removed');
    await invite(carol, 'member');
    const carolId = await meId(carol.token);
    await app.get(MembersProjectionSubscriber).settle(ws);
    const rec = await newRecord('Carol was on this');
    await patch(rec.id, { [single.apiName]: carolId });
    expect((await changesFor(rec.id, 'Assignee'))[0]).toMatchObject({ new_display: 'Carol Removed' }); // KEEP: while she is a member, she is named
    const membership = (await as(admin.token, 'GET', `/workspaces/${ws}/members`)).json().find((m: { user: { email: string } }) => m.user.email === carol.email);
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/members/${membership.id}`)).statusCode).toBeLessThan(300);
    await app.get(MembersProjectionSubscriber).settle(ws);
    const after = (await changesFor(rec.id, 'Assignee'))[0]!;
    expect(after.new_display).toBe('A former member');
    expect(after.new_value, 'the raw stored id is untouched').toBe(carolId);
    noRawIdIn(after, carolId);
    expect(JSON.stringify(after.new_display)).not.toContain('Carol');
  });

  it('an id with no Members row at all, a system id and an agent id are labelled by what they are', async () => {
    const rec = await newRecord('Odd assignees');
    const values = ['a1b2c3-never-a-member', 'system:members-projection', 'system', 'agent:7f3c', adaId];
    for (const v of values) {
      await testDb.insert(recordFieldChanges).values({ workspaceId: ws, databaseId: dbId, recordId: rec.id, fieldId: single.id, actorUserId: null, source: 'human', oldValue: null, newValue: v });
    }
    const rows = await changesFor(rec.id, 'Assignee');
    const by = (v: string) => rows.find((r) => r.new_value === v)!;
    expect(by('a1b2c3-never-a-member').new_display).toBe('A former member');
    expect(by('system:members-projection').new_display).toBe('Members sync');
    expect(by('system').new_display).toBe('StoryOS');
    expect(by('agent:7f3c').new_display).toBe('An agent');
    expect(by(adaId).new_display, 'KEEP: a real member beside the odd ones').toBe('Ada Lovelace');
    for (const v of values.slice(0, 4)) noRawIdIn(by(v), v);
  });

  it('a GUEST is not told the name of a person whose Members row they may not read; a guest holding a grant on that row is', async () => {
    const elsewhere = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Elsewhere' })).json().id as string;
    await invite(guest, 'guest', [{ space_id: elsewhere, role: 'viewer' }]);
    const guestMembership = await membershipOf(await meId(guest.token));
    const resolved = await people().resolveMembersForUsers(ws, [adaId, bobId]);
    const adaRow = resolved.get(adaId)!;
    const bobRow = resolved.get(bobId)!;
    const read = async (m: Membership) => ({ members: resolved, visible: await presentAuditRecords(testDb, app.get(AccessService), m, [adaRow.recordId, bobRow.recordId]) });
    const asGuest = await read(guestMembership);
    expect(displayUserValue(adaId, asGuest), 'REJECT: no grant on the Members database').toBe('A person you cannot see');
    expect(displayUserValue([adaId, bobId], asGuest)).toEqual(['A person you cannot see', 'A person you cannot see']);
    expect(JSON.stringify(displayUserValue([adaId, bobId], asGuest))).not.toMatch(/Ada|Bob|[0-9a-f]{8}/);
    // KEEP: the same rule lets the person through where the viewer may read the row (an admin; and a record grant for a guest)
    const asAdmin = await read(await membershipOf(await meId(admin.token)));
    expect(displayUserValue([adaId, bobId], asAdmin)).toEqual(['Ada Lovelace', 'Bob Barker']);
    const g2 = await signUpUser(app, 'Granted Guest');
    await invite(g2, 'guest', [{ space_id: elsewhere, role: 'viewer' }, { record_id: adaRow.recordId, role: 'viewer' }]);
    const granted = await read(await membershipOf(await meId(g2.token)));
    expect(displayUserValue(adaId, granted), 'KEEP: a guest granted that one row').toBe('Ada Lovelace');
    expect(displayUserValue(bobId, granted), 'REJECT: but not the neighbour row').toBe('A person you cannot see');
  });
});

describe('#1287 no N+1: user-field rows do not add statements per person or per row', () => {
  async function count(fn: () => Promise<unknown>): Promise<number> {
    const poolClient = (app.get(DB) as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
    const original = poolClient.query.bind(poolClient);
    let n = 0;
    poolClient.query = (...args: unknown[]) => { n += 1; return original(...args); };
    try { await fn(); } finally { poolClient.query = original; }
    return n;
  }
  it('1 row and 80 rows of user-field changes cost the same number of statements', async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await newRecord(`Assigned ${i}`);
      await patch(r.id, { [single.apiName]: i % 2 ? adaId : bobId, [multi.apiName]: [adaId, bobId] });
      await patch(r.id, { [single.apiName]: i % 2 ? bobId : adaId });
    }
    // the newest rows name ONE person, the big page names two: a per-person lookup would cost more on the big page
    for (const t of ['Newest A', 'Newest B']) await patch((await newRecord(t)).id, { [single.apiName]: adaId });
    // both pages hold user-field and record rows only (a select-field page would add the one options read, which is not what is measured here)
    const few = await count(async () => { expect((await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=1`)).statusCode).toBe(200); });
    let userRows = 0;
    const many = await count(async () => {
      const rows = (await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=80`)).json().data as UserRow[];
      userRows = rows.filter((r) => r.field_type === 'user').length;
    });
    expect(userRows, 'the big page must actually carry user-field rows').toBeGreaterThan(30);
    expect(many, `1 row costs ${few} statements; 80 rows with ${userRows} user-field rows must cost the same`).toBe(few);
  });
});
