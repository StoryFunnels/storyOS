import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #473 — SUB-ITEMS are not inherited. Otto's ruling (2026-09-24): a grant on a parent
 * record does NOT confer access to its sub-items; they are records and need their own grant.
 *
 * Why this file exists: that ruling was recorded as "the one case with no existing
 * test at all". Every other record-scoped test (#474 phase 3, #778, #688) relates two
 * DIFFERENT databases. A sub-item lives in the SAME database as its parent, through a
 * self-relation, and nothing exercised that shape. So the claim "sub-items are covered by
 * the same path as any linked record" was an inference, and this is the check.
 *
 * THIS IS A SECURITY BOUNDARY. Every assertion is about the RESPONSE BODY a real
 * record-scoped-only guest receives, never the UI: a child the API returns and the client
 * hides is a leak. The strongest form used throughout is that the serialised body does not
 * contain the child's id or title at all.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let tasksDb: string;
let parent: string;
let child1: string;
let child2: string;
let subItemsFieldId: string;
let subItemsApi: string;
let countApi: string;

const CHILD1 = 'Sub-item ONE (secret title)';
const CHILD2 = 'Sub-item TWO (secret title)';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recordUrl = (id: string) => `/workspaces/${wsId}/databases/${tasksDb}/records/${id}`;
const setGrant = (recordId: string, role = 'viewer') => as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, record_id: recordId, role });

const BOUNDARY = 'X-SUBITEMS-BOUNDARY';
const upload = (recordId: string, token = admin.token) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${recordUrl(recordId)}/attachments`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="f.txt"\r\ncontent-type: text/plain\r\n\r\n`),
      Buffer.from('payload'),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SubItemsOwner');
  guest = await signUpUser(app, 'SubItemsGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '473 Sub-items WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  // A SELF-relation: both sides are the Tasks database. That is what a sub-item is.
  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: tasksDb,
    cardinality: 'one_to_many',
    // The A side is the SINGLE-valued side (a child's one parent); the B side holds many.
    field_a_name: 'Parent task',
    field_b_name: 'Sub-items',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);
  subItemsFieldId = rel.json().field_b.id;
  subItemsApi = rel.json().field_b.api_name ?? rel.json().field_b.apiName;

  const make = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name } })).json().id as string;
  parent = await make('The parent task');
  child1 = await make(CHILD1);
  child2 = await make(CHILD2);
  const linked = await as(admin.token, 'POST', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: [child1, child2] });
  expect(linked.statusCode, linked.body).toBeLessThan(300);

  const count = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, {
    display_name: 'Sub-item count',
    type: 'rollup',
    config: { relation_field_id: subItemsFieldId, op: 'count' },
  });
  expect(count.statusCode, count.body).toBeLessThan(300);
  countApi = count.json().apiName ?? count.json().api_name;

  await upload(parent);
  await upload(child1);

  // The guest holds a record-scoped grant on the PARENT and nothing else: no space or database grant.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: parent, role: 'viewer' }],
  });
  await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#473 — a grant on a parent does NOT reach its sub-items', () => {
  it('the parent response carries no trace of the sub-items: no chip, no id, no title', async () => {
    const res = await as(guest.token, 'GET', recordUrl(parent));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.values[subItemsApi], 'the chip array must be absent, not redacted').toBeUndefined();
    const text = JSON.stringify(body);
    for (const leaked of [CHILD1, CHILD2, child1, child2]) expect(text, `leaked "${leaked}"`).not.toContain(leaked);
  });

  it('each sub-item is a 404 to the guest, by id, and absent from a list query', async () => {
    expect((await as(guest.token, 'GET', recordUrl(child1))).statusCode).toBe(404);
    expect((await as(guest.token, 'GET', recordUrl(child2))).statusCode).toBe(404);
    const list = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records/query`, { limit: 50 });
    expect(list.statusCode, list.body).toBeLessThan(300);
    const ids = (list.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([parent]);
    expect(JSON.stringify(list.json())).not.toContain('secret title');
  });

  it("a rollup over the sub-items counts only what the guest can see, in values AND computed_values", async () => {
    const adminView = (await as(admin.token, 'GET', recordUrl(parent))).json();
    expect(adminView.values[countApi]).toBe(2);
    const guestView = (await as(guest.token, 'GET', recordUrl(parent))).json();
    expect(guestView.values[countApi]).toBe(0);
    // #778: the materialised twin must not hand back the true count.
    const twin = Object.values(guestView.computed_values ?? {}).filter((v) => typeof v === 'number');
    expect(twin).not.toContain(2);
  });

  it("the parent's own attachment is reachable, and a sub-item's file is not, even by its direct URL", async () => {
    const own = await as(guest.token, 'GET', `${recordUrl(parent)}/attachments`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data).toHaveLength(1);

    const childFiles = (await as(admin.token, 'GET', `${recordUrl(child1)}/attachments`)).json().data as Array<{ id: string }>;
    expect(childFiles).toHaveLength(1);
    expect((await as(guest.token, 'GET', `${recordUrl(child1)}/attachments`)).statusCode).toBe(404);
    expect((await as(guest.token, 'GET', `${recordUrl(child1)}/attachments/${childFiles[0]!.id}/download`)).statusCode).toBe(404);
    expect((await as(guest.token, 'GET', `${recordUrl(child1)}/attachments/${childFiles[0]!.id}/thumbnail`)).statusCode).toBe(404);
    // And the id of a sub-item's file must not be usable through the PARENT's route either.
    expect((await as(guest.token, 'GET', `${recordUrl(parent)}/attachments/${childFiles[0]!.id}/download`)).statusCode).toBe(404);
  });

  it('the relation picker (listLinks) agrees: it shows the guest no sub-items', async () => {
    const res = await as(guest.token, 'GET', `${recordUrl(parent)}/links/${subItemsFieldId}`);
    expect(res.statusCode, res.body).toBeLessThan(500);
    if (res.statusCode === 200) {
      expect(JSON.stringify(res.json())).not.toContain('secret title');
      expect(JSON.stringify(res.json())).not.toContain(child1);
    }
  });
});

describe('#473 — the other direction, and widening', () => {
  it('a grant on ONE sub-item widens only that one: the chip, the count, the record', async () => {
    expect((await setGrant(child1)).statusCode).toBeLessThan(300);
    const view = (await as(guest.token, 'GET', recordUrl(parent))).json();
    const chips = (view.values[subItemsApi] ?? []) as Array<{ id: string }>;
    expect(chips.map((c) => c.id)).toEqual([child1]);
    expect(view.values[countApi]).toBe(1);
    expect(JSON.stringify(view)).not.toContain(CHILD2);
    expect(JSON.stringify(view)).not.toContain(child2);
    expect((await as(guest.token, 'GET', recordUrl(child1))).statusCode).toBe(200);
    expect((await as(guest.token, 'GET', recordUrl(child2))).statusCode).toBe(404);
  });

  it("holding a sub-item does not give up its PARENT: the child's back-relation shows nothing about a parent the guest cannot see", async () => {
    const other = (await signUpUser(app, 'SubItemsChildOnly'));
    const otherId = (await as(other.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: other.email,
      role: 'guest',
      grants: [{ record_id: child2, role: 'viewer' }],
    });
    await as(other.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')!.toString() });
    void otherId;

    const res = await as(other.token, 'GET', recordUrl(child2));
    expect(res.statusCode, res.body).toBe(200);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('The parent task');
    expect(text).not.toContain(parent);
    expect((await as(other.token, 'GET', recordUrl(parent))).statusCode).toBe(404);
  });
});
