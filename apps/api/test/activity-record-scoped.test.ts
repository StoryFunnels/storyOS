import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #845 — a record-scoped guest's activity surfaces must not name a record they cannot read.
 *
 * The record trail stored `{ other: { id, title } }` on every relation.linked/unlinked event
 * (and `{ target_record_id }` on reference.created) and returned it verbatim; the door
 * (assertRecordAccess on the record being READ) was checked, the contents never. The same
 * gap sat in the two comment+reference feeds: the database feed listed EVERY record's
 * comments to a guest with one record grant, and the hierarchy feed resolved a mention's
 * target chip with no visibility check.
 *
 * THE ADMIN CONTROL IS PART OF EVERY TEST, not a separate one: a "fix" that empties the
 * payload for everyone passes the guest assertion while destroying the audit trail. Stored
 * events are never rewritten — narrowing happens on read.
 *
 * Every assertion is on the RESPONSE BODY.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let tasksDb: string;
let clientsDb: string;
let parent: string;
let child1: string;
let child2: string;
let child3: string;
let child4: string;
let createdParent: string;
let autoParent: string;
let subItemsFieldId: string;
let subItemsApi: string;
let autoRelationId: string;

const CHILD1 = 'Sub-item ONE (secret title)';
const CHILD2 = 'Sub-item TWO (secret title)';
const CHILD3 = 'Sub-item THREE (linked then unlinked)';
const CHILD4 = 'Sub-item FOUR (linked at create)';
const CLIENT = 'Secret Client Co (auto-linked)';
const SECRET_COMMENT = 'a comment on a record the guest cannot read';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recordUrl = (id: string, db = tasksDb) => `/workspaces/${wsId}/databases/${db}/records/${id}`;
const trail = async (token: string, id: string) => {
  const res = await as(token, 'GET', `${recordUrl(id)}/activity?limit=100`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { data: Array<{ type: string; payload: Record<string, unknown> }> };
};
const text = (v: unknown) => JSON.stringify(v);

async function makeRecord(db: string, values: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function addField(db: string, name: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/fields`, { display_name: name, type: 'text' });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (res.json().apiName ?? res.json().api_name) as string;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ActivityOwner');
  guest = await signUpUser(app, 'ActivityGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '845 Activity WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  clientsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;

  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: tasksDb,
    cardinality: 'one_to_many',
    field_a_name: 'Parent task',
    field_b_name: 'Sub-items',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);
  subItemsFieldId = rel.json().field_b.id;
  subItemsApi = rel.json().field_b.api_name ?? rel.json().field_b.apiName;

  parent = await makeRecord(tasksDb, { name: 'The parent task' });
  child1 = await makeRecord(tasksDb, { name: CHILD1 });
  child2 = await makeRecord(tasksDb, { name: CHILD2 });
  child3 = await makeRecord(tasksDb, { name: CHILD3 });
  child4 = await makeRecord(tasksDb, { name: CHILD4 });

  // Writer 1: relation.linked via RelationsService.writeLinkEvents.
  const linked = await as(admin.token, 'POST', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: [child1, child2, child3] });
  expect(linked.statusCode, linked.body).toBeLessThan(300);
  // Writer 2: relation.unlinked, same payload shape.
  const unlinked = await as(admin.token, 'DELETE', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: [child3] });
  expect(unlinked.statusCode, unlinked.body).toBeLessThan(300);
  // Writer 4: the create path in RecordsService (relation values supplied on create).
  createdParent = await makeRecord(tasksDb, { name: 'Parent created with links', [subItemsApi]: [child4] });

  // Writer 3: AutoLinkService, across two databases.
  const taskEmail = await addField(tasksDb, 'Email');
  const clientEmail = await addField(clientsDb, 'Email');
  const autoRel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: clientsDb,
    cardinality: 'many_to_many',
  });
  expect(autoRel.statusCode, autoRel.body).toBeLessThan(300);
  autoRelationId = autoRel.json().id;
  autoParent = await makeRecord(tasksDb, { name: 'Auto-linked parent', [taskEmail]: 'match@acme.test' });
  await makeRecord(clientsDb, { name: CLIENT, [clientEmail]: 'match@acme.test' });
  const set = await as(admin.token, 'PATCH', `/workspaces/${wsId}/relations/${autoRelationId}`, {
    auto_link: { conditions: [{ field_a: taskEmail, field_b: clientEmail }], case_sensitive: false },
  });
  expect(set.statusCode, set.body).toBeLessThan(300);
  const run = await as(admin.token, 'POST', `/workspaces/${wsId}/relations/${autoRelationId}/auto-link`);
  expect(run.statusCode, run.body).toBeLessThan(300);

  // reference.created: the parent's document mentions a sub-item the guest cannot read.
  const doc = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, {
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ', styles: {} }, { type: 'mention', props: { kind: 'record', id: child1, label: CHILD1 } }] }],
    expected_version: 0,
  });
  expect(doc.statusCode, doc.body).toBeLessThan(300);
  // A comment on a sub-item (record the guest cannot read).
  const comment = await as(admin.token, 'POST', `${recordUrl(child1)}/comments`, { body: [{ type: 'text', text: SECRET_COMMENT }] });
  expect(comment.statusCode, comment.body).toBeLessThan(300);

  // The guest holds record-scoped grants on the three parents and nothing else.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [
      { record_id: parent, role: 'viewer' },
      { record_id: createdParent, role: 'viewer' },
      { record_id: autoParent, role: 'viewer' },
    ],
  });
  await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#845 — the record trail names nothing the guest cannot read (admin control in every test)', () => {
  it('relation.linked via writeLinkEvents: guest sees no id or title; admin still sees both', async () => {
    const adminTrail = text(await trail(admin.token, parent));
    expect(adminTrail).toContain(CHILD1);
    expect(adminTrail).toContain(child1);
    const g = await trail(guest.token, parent);
    expect(g.data.length, 'the guest still gets the parent\'s own trail').toBeGreaterThan(0);
    expect(g.data.some((e) => e.type === 'record.created')).toBe(true);
    for (const leaked of [CHILD1, CHILD2, child1, child2]) expect(text(g), `leaked "${leaked}"`).not.toContain(leaked);
  });

  it('relation.unlinked via writeLinkEvents', async () => {
    const adminTrail = await trail(admin.token, parent);
    expect(adminTrail.data.some((e) => e.type === 'relation.unlinked' && text(e.payload).includes(CHILD3))).toBe(true);
    const g = await trail(guest.token, parent);
    expect(g.data.some((e) => e.type === 'relation.unlinked')).toBe(false);
    for (const leaked of [CHILD3, child3]) expect(text(g), `leaked "${leaked}"`).not.toContain(leaked);
  });

  it('the create path in RecordsService', async () => {
    expect(text(await trail(admin.token, createdParent))).toContain(CHILD4);
    const g = await trail(guest.token, createdParent);
    for (const leaked of [CHILD4, child4]) expect(text(g), `leaked "${leaked}"`).not.toContain(leaked);
  });

  it('AutoLinkService, across databases', async () => {
    expect(text(await trail(admin.token, autoParent))).toContain(CLIENT);
    const g = await trail(guest.token, autoParent);
    expect(text(g)).not.toContain(CLIENT);
  });

  it('reference.created (a mention): the target id is not handed over either', async () => {
    const adminTrail = await trail(admin.token, parent);
    expect(adminTrail.data.some((e) => e.type === 'reference.created' && text(e.payload).includes(child1))).toBe(true);
    const g = await trail(guest.token, parent);
    expect(g.data.some((e) => e.type === 'reference.created')).toBe(false);
    expect(text(g)).not.toContain(child1);
  });
});

describe('#845 — the two comment+reference feeds', () => {
  it("the DATABASE feed lists only records the guest can read; admin sees the sub-item's comment", async () => {
    const adminFeed = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}/activity/comments`);
    expect(text(adminFeed.json())).toContain(SECRET_COMMENT);
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}/activity/comments`);
    expect(res.statusCode, res.body).toBe(200);
    expect(text(res.json())).not.toContain(SECRET_COMMENT);
    expect(text(res.json())).not.toContain(CHILD1);
    expect(text(res.json())).not.toContain(child1);
  });

  it("the HIERARCHY feed: a mention's hidden target chip is not resolved; hidden children's comments stay out", async () => {
    const url = `${recordUrl(parent)}/activity/hierarchy?relation_field_ids=${subItemsFieldId}`;
    const adminFeed = await as(admin.token, 'GET', url);
    expect(adminFeed.statusCode, adminFeed.body).toBe(200);
    expect(text(adminFeed.json())).toContain(CHILD1);
    expect(text(adminFeed.json())).toContain(SECRET_COMMENT);
    const res = await as(guest.token, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    for (const leaked of [CHILD1, child1, SECRET_COMMENT]) expect(text(res.json()), `leaked "${leaked}"`).not.toContain(leaked);
  });
});

describe('#845 — narrowing is per record, not a blanket', () => {
  it('a grant on ONE sub-item makes only that one appear in the parent trail', async () => {
    const granted = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, record_id: child2, role: 'viewer' });
    expect(granted.statusCode, granted.body).toBeLessThan(300);
    const g = await trail(guest.token, parent);
    expect(text(g)).toContain(CHILD2);
    expect(text(g)).toContain(child2);
    expect(text(g)).not.toContain(CHILD1);
    expect(text(g)).not.toContain(child1);
  });

  it('members keep the full trail', async () => {
    const adminTrail = text(await trail(admin.token, parent));
    for (const seen of [CHILD1, CHILD2, CHILD3]) expect(adminTrail).toContain(seen);
  });
});
