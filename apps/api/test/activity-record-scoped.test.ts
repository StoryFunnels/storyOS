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

/**
 * Vera's send-back on PR #987: post-filtering a paged query strands the guest. With a run of
 * hidden events longer than `limit` the first page was EMPTY with has_more=true and no cursor.
 * The exclusion now lives in the query, so every page is full of readable rows and every
 * cursor comes from one. The cursor is a plain base64 timestamp, so "from the last raw row"
 * would also have handed the guest the time of an event they cannot see.
 */
describe('#845 — pagination over a run of hidden events', () => {
  let pagedParent: string;
  const HIDDEN = 7;
  const hiddenIds: string[] = [];

  beforeAll(async () => {
    pagedParent = await makeRecord(tasksDb, { name: 'Parent with a long hidden tail' });
    // An early, readable event the guest must still be able to reach: a comment.
    const early = await as(admin.token, 'POST', `${recordUrl(pagedParent)}/comments`, { body: [{ type: 'text', text: 'EARLY readable comment' }] });
    expect(early.statusCode, early.body).toBeLessThan(300);
    for (let i = 0; i < HIDDEN; i += 1) hiddenIds.push(await makeRecord(tasksDb, { name: `Hidden child ${i}` }));
    // 7 relation.linked events, all NEWER than the comment, all naming records the guest cannot read.
    // ONE REQUEST PER LINK, deliberately: events written in a single transaction share a
    // created_at, and the cursor is `created_at < cursor`, so a page boundary inside a tie
    // skips the rest of the tie for EVERYONE, admins included. That is a separate, pre-existing
    // defect (reported on ticket #845), and this test must measure the guest filter, not it.
    for (const id of hiddenIds) {
      const linked = await as(admin.token, 'POST', `${recordUrl(pagedParent)}/links/${subItemsFieldId}`, { record_ids: [id] });
      expect(linked.statusCode, linked.body).toBeLessThan(300);
    }
    const grant = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, record_id: pagedParent, role: 'viewer' });
    expect(grant.statusCode, grant.body).toBeLessThan(300);
  });

  async function walk(token: string, limit: number) {
    const types: string[] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const qs: string = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await as(token, 'GET', `${recordUrl(pagedParent)}/activity?${qs}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { data: Array<{ type: string; created_at: string }>; next_cursor: string | null; has_more: boolean };
      types.push(...body.data.map((e) => e.type));
      if (body.has_more) {
        expect(body.next_cursor, 'has_more must come with a cursor').not.toBeNull();
        expect(body.data.length, 'a page with more behind it must not be empty').toBeGreaterThan(0);
        cursors.push(body.next_cursor!);
        cursor = body.next_cursor;
      } else {
        return { types, cursors };
      }
    }
    throw new Error('pagination did not terminate');
  }

  it('a guest pages through the hidden run and reaches the older events; the admin walks the same trail', async () => {
    const admin3 = await walk(admin.token, 3);
    const guest3 = await walk(guest.token, 3);
    expect(admin3.types.filter((t) => t === 'relation.linked')).toHaveLength(HIDDEN);
    expect(admin3.types).toContain('record.created');
    // The guest reaches record.created and the comment, and sees none of the seven links.
    expect(guest3.types).toContain('record.created');
    expect(guest3.types).toContain('comment.created');
    expect(guest3.types.filter((t) => t === 'relation.linked')).toHaveLength(0);
    // Same events minus exactly the hidden ones: nothing readable is lost to paging.
    expect(guest3.types.length).toBe(admin3.types.length - HIDDEN);
  });

  it("no cursor handed to the guest encodes the time OR the id of an event they cannot see", async () => {
    const adminAll = await as(admin.token, 'GET', `${recordUrl(pagedParent)}/activity?limit=100`);
    const hiddenEvents = (adminAll.json().data as Array<{ id: string; type: string; created_at: string }>).filter((e) => e.type === 'relation.linked');
    const hiddenTimes = new Set(hiddenEvents.map((e) => new Date(e.created_at).getTime()));
    const hiddenEventIds = new Set(hiddenEvents.map((e) => e.id));
    expect(hiddenTimes.size).toBeGreaterThan(0);
    const { cursors } = await walk(guest.token, 1); // the guest has only a couple of readable events
    expect(cursors.length).toBeGreaterThan(0);
    for (const c of cursors) {
      // The cursor is opaque base64url JSON `{ t, id }` of the last row the guest was handed (#849).
      const decoded = JSON.parse(Buffer.from(c, 'base64url').toString()) as { t: string; id: string };
      expect(hiddenTimes.has(new Date(decoded.t).getTime()), `cursor time ${decoded.t} is a hidden event's`).toBe(false);
      expect(hiddenEventIds.has(decoded.id), `cursor id ${decoded.id} is a hidden event's`).toBe(false);
    }
  });

  it('the hierarchy feed paginates the same way over hidden reference events', async () => {
    const doc = await as(admin.token, 'PUT', `${recordUrl(pagedParent)}/document`, {
      content: [{ type: 'paragraph', content: hiddenIds.flatMap((id, i) => [{ type: 'mention', props: { kind: 'record', id, label: `Hidden child ${i}` } }, { type: 'text', text: ' ', styles: {} }]) }],
      expected_version: 0,
    });
    expect(doc.statusCode, doc.body).toBeLessThan(300);
    const url = (cursor: string | null) =>
      `${recordUrl(pagedParent)}/activity/hierarchy?relation_field_ids=${subItemsFieldId}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await as(guest.token, 'GET', url(cursor));
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { data: Array<{ type: string; comment?: { snippet: string } }>; next_cursor: string | null; has_more: boolean };
      seen.push(...body.data.map((e) => (e.type === 'comment.created' ? `comment:${e.comment!.snippet}` : e.type)));
      if (!body.has_more) break;
      expect(body.data.length).toBeGreaterThan(0);
      cursor = body.next_cursor;
    }
    expect(seen).toContain('comment:EARLY readable comment');
    expect(seen).not.toContain('reference.created');
  });
});
