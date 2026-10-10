import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { recordLinks, records } from '../src/db/schema';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';

/**
 * #597 — the first implementation of ADR-0012's guided conversion: a `user` field <-> a relation to the
 * Members database, dry run first, nothing dropped, permission-neutral per role.
 *
 * Fixture: Tasks lives in its own space; the Members database lives in the default space. Two guests:
 * `blind` (a grant on Tasks' space only, so NO access to Members) and `sighted` (Tasks' space AND Members').
 * The per-role assertions are on response BODIES, because "a chip is not shown" is a property of what the
 * response contains, not of a status code.
 */
let app: NestFastifyApplication;
let db: Db;
let subscriber: MembersProjectionSubscriber;
let owner: { token: string; email: string };
let alice: { token: string; email: string };
let carol: { token: string; email: string };
let blind: { token: string; email: string };
let sighted: { token: string; email: string };
let ws: string;
let generalSpace: string;
let taskSpace: string;
let tasks: string;
let members: string;
let assigneeField: string;
let aliceId: string;
let carolId: string;
let aliceMemberRow: string;
let t1: string; // assigned to alice
let t2: string; // assigned to carol
let t3: string; // assigned to a user id that has NO Members row (must be parked, never dropped)
let t4: string; // unassigned
const GHOST = 'ghost-user-without-a-members-row';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const convertUrl = (field = assigneeField, kind: 'convert-to-members-relation' | 'convert-to-user' = 'convert-to-members-relation', dbId = tasks) =>
  `/workspaces/${ws}/databases/${dbId}/fields/${field}/${kind}`;

async function join(user: { token: string; email: string }, role: 'member' | 'guest', grants?: unknown[]) {
  const invite = await as(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: user.email, role, ...(grants ? { grants } : {}) });
  expect(invite.statusCode, invite.body).toBe(201);
  const accept = await as(user.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  expect(accept.statusCode, accept.body).toBe(201);
  await subscriber.settle(ws);
}
const detail = async (token: string, dbId: string) => (await as(token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json();
const fieldByName = async (token: string, dbId: string, name: string) =>
  (await detail(token, dbId)).fields.find((f: { displayName: string }) => f.displayName === name);
const listTasks = async (token: string) => as(token, 'GET', `/workspaces/${ws}/databases/${tasks}/records?limit=50`);
const linkCount = async () => (await db.select().from(recordLinks)).length;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  subscriber = app.get(MembersProjectionSubscriber);
  owner = await signUpUser(app, 'Conv Owner');
  alice = await signUpUser(app, 'Alice Conv');
  carol = await signUpUser(app, 'Carol Conv');
  blind = await signUpUser(app, 'Blind Guest');
  sighted = await signUpUser(app, 'Sighted Guest');
  aliceId = (await as(alice.token, 'GET', '/me')).json().id;
  carolId = (await as(carol.token, 'GET', '/me')).json().id;

  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'Conv WS' })).json().id;
  await subscriber.settle(ws);
  generalSpace = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  taskSpace = (await as(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Delivery' })).json().id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: taskSpace, name: 'Tasks' })).json().id;
  members = ((await as(owner.token, 'GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Members')!.id;

  await join(alice, 'member');
  await join(carol, 'member');
  await join(blind, 'guest', [{ space_id: taskSpace, role: 'viewer' }]);
  await join(sighted, 'guest', [{ space_id: taskSpace, role: 'viewer' }, { space_id: generalSpace, role: 'viewer' }]);

  const f = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Assignee', type: 'user' });
  expect(f.statusCode, f.body).toBe(201);
  assigneeField = f.json().id;
  const mk = async (name: string, value?: string) =>
    (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name, ...(value ? { assignee: value } : {}) } })).json().id as string;
  t1 = await mk('Task one', aliceId);
  t2 = await mk('Task two', carolId);
  t4 = await mk('Task four');
  t3 = await mk('Task three');
  // A user id nothing resolves: written straight to storage, as legacy data can be.
  await db.update(records).set({ values: { ...(await db.query.records.findFirst({ where: eq(records.id, t3) }))!.values as object, [assigneeField]: GHOST } }).where(eq(records.id, t3));
  aliceMemberRow = ((await as(owner.token, 'GET', `/workspaces/${ws}/databases/${members}/records?limit=50`)).json().data as Array<{ id: string; values: Record<string, unknown> }>).find((r) => r.values['user_id'] === aliceId)!.id;
}, 240_000);

afterAll(async () => { await app.close(); });

describe('#597 dry run (the default) changes nothing and tells the truth', () => {
  it('an empty body is a dry run; it reports counts, the parked set and the per-role proof', async () => {
    const before = await linkCount();
    const res = await as(owner.token, 'POST', convertUrl(), {});
    expect(res.statusCode, res.body).toBeLessThan(300);
    const plan = res.json();
    expect(plan.dry_run).toBe(true);
    expect(plan.cardinality).toBe('one_to_many');
    expect(plan.counts).toMatchObject({ records_with_value: 3, records_that_will_link: 2, links_to_write: 2, records_with_unresolvable_values: 1 });
    expect(plan.parked.sample[0]).toMatchObject({ record_id: t3, user_ids: [GHOST] });
    expect(plan.after).toMatchObject({ retained_field_name: 'Assignee (user)', relation_field_name: 'Assignee', inverse_field_name: 'Tasks / Assignee', inverse_field_hidden_by_default: true });
    // permission neutrality: both guests evaluated, nobody gains
    expect(plan.permission_neutrality.neutral).toBe(true);
    const byBlind = plan.permission_neutrality.roles.find((r: { can_read_members_database: boolean }) => !r.can_read_members_database);
    const bySighted = plan.permission_neutrality.roles.find((r: { can_read_members_database: boolean }) => r.can_read_members_database);
    expect(byBlind.sees_chips_after).toBe(false);
    expect(bySighted.sees_chips_after).toBe(true);
    expect(plan.permission_neutrality.chip_exposes.join(' ')).not.toMatch(/email|avatar|role/);
    // and nothing was written
    expect(await linkCount()).toBe(before);
    expect(await fieldByName(owner.token, tasks, 'Assignee (user)')).toBeUndefined();
    expect(await fieldByName(owner.token, tasks, 'Assignee')).toMatchObject({ type: 'user' });
  });

  it('only an admin may run it, and a bound token cannot reach it at all', async () => {
    expect((await as(alice.token, 'POST', convertUrl(), {})).statusCode).toBe(403);
    expect((await as(sighted.token, 'POST', convertUrl(), {})).statusCode).toBe(403);
    const bound = (await as(owner.token, 'POST', '/me/tokens', { name: 'b', workspace_id: ws, resource_scope: { database_ids: [tasks] } })).json().token;
    expect((await as(bound, 'POST', convertUrl(), {})).statusCode).toBe(403);
  });

  it('refuses a field that is not a user field', async () => {
    const title = (await detail(owner.token, tasks)).fields.find((f: { type: string }) => f.type === 'title');
    const res = await as(owner.token, 'POST', convertUrl(title.id), { dry_run: false });
    expect(res.statusCode).toBe(422);
  });
});

describe('#597 apply: the relation, the retained original, the parked set', () => {
  let relationFieldId: string;
  let inverseFieldId: string;
  let applied: { applied: { relation_id: string; relation_field_id: string; inverse_field_id: string; links_written: number; records_parked: number } };

  beforeAll(async () => {
    const res = await as(owner.token, 'POST', convertUrl(), { dry_run: false });
    expect(res.statusCode, res.body).toBeLessThan(300);
    applied = res.json();
    relationFieldId = applied.applied.relation_field_id;
    inverseFieldId = applied.applied.inverse_field_id;
  });

  it('writes the links, keeps the original (renamed), and puts the relation under the original name', async () => {
    expect(applied.applied.links_written).toBe(2);
    const retained = await fieldByName(owner.token, tasks, 'Assignee (user)');
    expect(retained).toMatchObject({ id: assigneeField, type: 'user', apiName: 'assignee' });
    const rel = await fieldByName(owner.token, tasks, 'Assignee');
    expect(rel).toMatchObject({ id: relationFieldId, type: 'relation' });
    expect(rel.apiName).not.toBe('assignee'); // the original keeps its api_name; the relation gets a new one
    const one = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${tasks}/records/${t1}`)).json();
    expect(one.values[rel.apiName]).toEqual([expect.objectContaining({ id: aliceMemberRow, title: 'Alice Conv' })]);
  });

  it('PARKED, NEVER DROPPED: the unresolvable value stays on the retained field and can be listed afterwards', async () => {
    expect(applied.applied.records_parked).toBe(1);
    const rel = await fieldByName(owner.token, tasks, 'Assignee');
    const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records/query`, {
      filter: { and: [{ field: rel.apiName, op: 'is_empty' }, { field: 'assignee', op: 'not_empty' }] }, limit: 50,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const found = res.json().data as Array<{ id: string; values: Record<string, unknown> }>;
    expect(found.map((r) => r.id)).toEqual([t3]);
    expect(found[0]!.values['assignee']).toBe(GHOST);
  });

  it('the inverse field exists on Members and is hidden by default (config and views)', async () => {
    const inverse = await fieldByName(owner.token, members, 'Tasks / Assignee');
    expect(inverse).toMatchObject({ id: inverseFieldId, type: 'relation' });
    expect(inverse.config.entity_hidden).toBe(true);
    const membersDetail = await detail(owner.token, members);
    for (const v of membersDetail.views) expect((v.config.hidden_field_ids ?? []) as string[]).toContain(inverseFieldId);
  });

  it('a second conversion of the SAME field is refused; a different user field gets its own relation and inverse', async () => {
    expect((await as(owner.token, 'POST', convertUrl(), { dry_run: false })).statusCode).toBe(409);
    const other = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Reviewer', type: 'user' })).json().id;
    const res = await as(owner.token, 'POST', convertUrl(other), { dry_run: false });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().applied.inverse_field_id).not.toBe(inverseFieldId);
    expect(await fieldByName(owner.token, members, 'Tasks / Reviewer')).toBeDefined();
    // the first inverse is untouched
    expect(await fieldByName(owner.token, members, 'Tasks / Assignee')).toMatchObject({ id: inverseFieldId });
  });
});

describe('#597 permission neutrality, proven per role on the response BODY after the conversion', () => {
  it('a guest with NO access to Members gets no chip, no name and nothing about Members', async () => {
    const res = await listTasks(blind.token);
    expect(res.statusCode, res.body).toBe(200);
    for (const needle of ['Alice Conv', 'Carol Conv', aliceMemberRow, '@', 'Members']) {
      expect(res.body, needle).not.toContain(needle);
    }
    const d = await as(blind.token, 'GET', `/workspaces/${ws}/databases/${tasks}`);
    expect(d.body).not.toContain('Members');
    expect(d.body).not.toContain(members);
  });

  it('a guest WITH access to Members sees the chip (the name and number) and no other Members column', async () => {
    const res = await listTasks(sighted.token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Alice Conv');
    const rel = await fieldByName(sighted.token, tasks, 'Assignee');
    const one = JSON.stringify((res.json().data as Array<{ id: string; values: Record<string, unknown> }>).find((r) => r.id === t1)!.values[rel.apiName]);
    expect(Object.keys(JSON.parse(one)[0]).sort()).toEqual(['id', 'number', 'title']);
    expect(one).not.toContain(alice.email);
  });

  it('admin and member see the chips, as everyone with workspace access always could', async () => {
    for (const token of [owner.token, alice.token]) expect((await listTasks(token)).body).toContain('Alice Conv');
  });
});

describe('#597 the reverse: relation -> user field, nothing dropped, no orphan on Members', () => {
  let relationField: { id: string; apiName: string };

  beforeAll(async () => {
    relationField = await fieldByName(owner.token, tasks, 'Assignee');
    // after the conversion, work continued on the RELATION: carol is reassigned to task four (a link the retained field never saw)
    const carolRow = ((await as(owner.token, 'GET', `/workspaces/${ws}/databases/${members}/records?limit=50`)).json().data as Array<{ id: string; values: Record<string, unknown> }>).find((r) => r.values['user_id'] === carolId)!.id;
    const put = await as(owner.token, 'PUT', `/workspaces/${ws}/databases/${tasks}/records/${t4}/links/${relationField.id}`, { record_ids: [carolRow] });
    expect(put.statusCode, put.body).toBeLessThan(300);
    // and a Members row with NO user id (an invited-but-not-joined person) is linked to task three
    const orphan = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${members}/records`, { values: { name: 'Pending Pat' } })).json().id;
    await as(owner.token, 'PUT', `/workspaces/${ws}/databases/${tasks}/records/${t3}/links/${relationField.id}`, { record_ids: [orphan] });
  });

  it('dry run by default: counts, the parked member names, what would be removed', async () => {
    const res = await as(owner.token, 'POST', convertUrl(relationField.id, 'convert-to-user'), {});
    expect(res.statusCode, res.body).toBeLessThan(300);
    const plan = res.json();
    expect(plan.dry_run).toBe(true);
    expect(plan.mode).toBe('restore the retained user field');
    expect(plan.after.inverse_field_removed).toBe(true);
    expect(plan.counts.records_with_unlinkable_members).toBe(1);
    expect(plan.parked.sample[0].member_names).toEqual(['Pending Pat']);
    // restoring a field this feature converted is a restore, so it is neutral
    expect(plan.permission_neutrality.neutral).toBe(true);
    expect(await fieldByName(owner.token, tasks, 'Assignee')).toMatchObject({ type: 'relation' });
  });

  it('a lookup built on the relation is REFUSED without confirm_dependents, and named', async () => {
    const lookup = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
      display_name: 'Assignee email', type: 'lookup', config: { relation_field_id: relationField.id, target_field_api_name: 'email' },
    });
    expect(lookup.statusCode, lookup.body).toBe(201);
    const refused = await as(owner.token, 'POST', convertUrl(relationField.id, 'convert-to-user'), { dry_run: false });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('Assignee email');
  });

  it('applies: values come from the RELATION (the source of truth), the original name is restored, the inverse is gone', async () => {
    const res = await as(owner.token, 'POST', convertUrl(relationField.id, 'convert-to-user'), { dry_run: false, confirm_dependents: true });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const field = await fieldByName(owner.token, tasks, 'Assignee');
    expect(field).toMatchObject({ id: assigneeField, type: 'user', apiName: 'assignee' });
    expect(await fieldByName(owner.token, tasks, 'Assignee (user)')).toBeUndefined();
    const get = async (id: string) => (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${tasks}/records/${id}`)).json().values;
    expect((await get(t1))['assignee']).toBe(aliceId);
    expect((await get(t4))['assignee']).toBe(carolId); // the link made AFTER conversion survived the round trip
    // no orphan on Members: both inverse fields were removed along with their relations (the Reviewer one stays, it is a different relation)
    expect(await fieldByName(owner.token, members, 'Tasks / Assignee')).toBeUndefined();
    expect(await fieldByName(owner.token, members, 'Tasks / Reviewer')).toBeDefined();
    // PARKED: the member with no user id is readable on the record, not dropped
    const parked = await fieldByName(owner.token, tasks, 'Assignee (unlinked members)');
    expect(parked).toBeDefined();
    expect((await get(t3))[parked.apiName]).toBe('Pending Pat');
  });
});
