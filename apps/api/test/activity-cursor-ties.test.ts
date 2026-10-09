import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #849 — the activity cursor was `created_at < cursor`. Every event written in ONE transaction
 * shares a created_at, so a page boundary inside such a group made the next query skip the rest
 * of it: a bulk link of 7 records, read at limit 3, returned 3. Silent: has_more and the cursor
 * behaved normally. It hit admins (this is not a permissions bug) and it hit an audit trail,
 * whose only value is completeness.
 *
 * The ordering key is now (created_at, id) and the comparison is a TUPLE; `<=` would return the
 * boundary row twice instead of dropping the rest. Every walk below asserts BOTH directions:
 * nothing missing AND nothing repeated.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let tasksDb: string;
let parent: string;
let subItemsFieldId: string;
let kids: string[] = [];

const N = 7;
const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recordUrl = (id: string) => `/workspaces/${wsId}/databases/${tasksDb}/records/${id}`;
const mk = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name } })).json().id as string;

type Page = { data: Array<{ id: string; type: string; payload?: Record<string, unknown>; created_at: string }>; next_cursor: string | null; has_more: boolean };

/** Walk a feed to the end with `limit`; returns every row id in order, asserting a stalled page cannot happen. */
async function walk(token: string, urlFor: (qs: string) => string, limit: number) {
  const out: Page['data'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 60; i += 1) {
    const res = await as(token, 'GET', urlFor(`limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as Page;
    out.push(...page.data);
    if (!page.has_more) return out;
    expect(page.data.length, 'a page with more behind it is never empty').toBeGreaterThan(0);
    expect(page.next_cursor, 'has_more comes with a cursor').not.toBeNull();
    cursor = page.next_cursor;
  }
  throw new Error('did not terminate');
}
const trail = (id: string) => (qs: string) => `${recordUrl(id)}/activity?${qs}`;
const ids = (rows: Page['data']) => rows.map((r) => r.id);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'TiesOwner');
  guest = await signUpUser(app, 'TiesGuest');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '849 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: tasksDb, cardinality: 'one_to_many', field_a_name: 'Parent task', field_b_name: 'Sub-items',
  });
  subItemsFieldId = rel.json().field_b.id;
  parent = await mk('Parent');
  for (let i = 0; i < N; i += 1) kids.push(await mk(`Child ${i}`));
  // ONE request, ONE transaction: seven relation.linked events with one shared created_at.
  const linked = await as(admin.token, 'POST', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: kids });
  expect(linked.statusCode, linked.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#849 — a run of events sharing one created_at is paged completely', () => {
  it('the premise: the seven link events really do share a created_at (otherwise this test proves nothing)', async () => {
    const all = await walk(admin.token, trail(parent), 100);
    const linked = all.filter((e) => e.type === 'relation.linked');
    expect(linked).toHaveLength(N);
    expect(new Set(linked.map((e) => e.created_at)).size, 'one transaction, one timestamp').toBe(1);
  });

  it('AS AN ADMIN, at every page size: every event, once, in the same order as one big page', async () => {
    const whole = ids(await walk(admin.token, trail(parent), 100));
    expect(whole.length).toBeGreaterThanOrEqual(N + 1);
    expect(new Set(whole).size, 'no duplicates in the reference read').toBe(whole.length);
    for (const limit of [1, 2, 3, 4, N, N + 1]) {
      const paged = ids(await walk(admin.token, trail(parent), limit));
      expect(paged, `limit ${limit}`).toEqual(whole);
    }
  });

  it('the measured case from the ticket: 7 written together, limit 3, all 7 come back', async () => {
    const paged = await walk(admin.token, trail(parent), 3);
    expect(paged.filter((e) => e.type === 'relation.linked')).toHaveLength(N);
  });

  it('a cursor minted before this change (a bare timestamp) still pages, rather than breaking mid-deploy', async () => {
    const first = (await as(admin.token, 'GET', `${recordUrl(parent)}/activity?limit=1`)).json() as Page;
    const legacy = Buffer.from(new Date(first.data[0]!.created_at).toISOString()).toString('base64url');
    const res = await as(admin.token, 'GET', `${recordUrl(parent)}/activity?limit=100&cursor=${legacy}`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('an unparseable cursor is ignored (page one), exactly as before', async () => {
    const res = await as(admin.token, 'GET', `${recordUrl(parent)}/activity?limit=2&cursor=%25%25%25`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('COMPOSES with the guest exclusion: a guest who can read 3 of the 7 gets exactly those 3 across any page size', async () => {
    const readable = kids.slice(0, 3);
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [parent, ...readable].map((record_id) => ({ record_id, role: 'viewer' })),
    });
    expect(invite.statusCode, invite.body).toBeLessThan(300);
    const accepted = await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);
    const adminAll = ids(await walk(admin.token, trail(parent), 100));
    const guestWhole = await walk(guest.token, trail(parent), 100);
    const guestLinked = guestWhole.filter((e) => e.type === 'relation.linked');
    expect(guestLinked, '3 readable children, 4 hidden, all in one tie').toHaveLength(3);
    for (const limit of [1, 2, 3]) {
      const paged = await walk(guest.token, trail(parent), limit);
      expect(ids(paged), `guest limit ${limit}`).toEqual(ids(guestWhole));
      expect(paged.filter((e) => e.type === 'relation.linked')).toHaveLength(3);
    }
    expect(guestWhole.length).toBeLessThan(adminAll.length); // the 4 hidden are still excluded
  });

  it('the hierarchy feed pages a same-transaction run of mentions completely (admin)', async () => {
    const doc = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, {
      content: [{ type: 'paragraph', content: kids.flatMap((id, i) => [{ type: 'mention', props: { kind: 'record', id, label: `Child ${i}` } }, { type: 'text', text: ' ', styles: {} }]) }],
      expected_version: 0,
    });
    expect(doc.statusCode, doc.body).toBeLessThan(300);
    const feed = (qs: string) => `${recordUrl(parent)}/activity/hierarchy?relation_field_ids=${subItemsFieldId}&${qs}`;
    const whole = await walk(admin.token, feed, 100);
    expect(whole.filter((e) => e.type === 'reference.created')).toHaveLength(N);
    for (const limit of [1, 3, 4]) {
      expect(ids(await walk(admin.token, feed, limit)), `hierarchy limit ${limit}`).toEqual(ids(whole));
    }
  });
});
