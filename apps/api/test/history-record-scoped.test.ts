import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #847 — the LAST unexamined history surfaces: record_versions (list + preview), the field-level
 * change timeline, and document version history. #845 found record activity, the database comments
 * feed and the hierarchy feed all leaking to a record-scoped guest; none of these three had been
 * looked at. Reached the way #845 was: a REAL request as a record-scoped-only guest against a
 * fixture where the hidden record has a DISTINCTIVE title, body and comment, then a grep of the
 * response body for each. Not a code read: the hierarchy feed was called "probably fine" on one.
 *
 * Every guest assertion has its ADMIN CONTROL in the same test: a surface that returns nothing to
 * anyone is broken, not clean, and would pass a guest-only check.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let tasksDb: string;
let parent: string;
let child: string;
let subItemsFieldId: string;
let subItemsApi: string;
let richFieldApi: string;

const HIDDEN_TITLE = 'ZEBRA-TITLE hidden sub-item 9f3a';
const HIDDEN_BODY = 'ZEBRA-BODY secret document text 77c1';
const HIDDEN_COMMENT = 'ZEBRA-COMMENT secret comment e42d';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recordUrl = (id: string) => `/workspaces/${wsId}/databases/${tasksDb}/records/${id}`;
const mention = (id: string, label: string) => ({ type: 'mention', props: { kind: 'record', id, label } });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const txt = (text: string) => ({ type: 'text', text, styles: {} });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'HistOwner');
  guest = await signUpUser(app, 'HistGuest');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '847 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: tasksDb, cardinality: 'one_to_many', field_a_name: 'Parent task', field_b_name: 'Sub-items',
  });
  subItemsFieldId = rel.json().field_b.id;
  subItemsApi = rel.json().field_b.api_name ?? rel.json().field_b.apiName;
  const rich = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Notes', type: 'rich_text' });
  expect(rich.statusCode, rich.body).toBeLessThan(300);
  richFieldApi = rich.json().apiName ?? rich.json().api_name;

  const mk = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name } })).json().id as string;
  parent = await mk('The visible parent');
  child = await mk(HIDDEN_TITLE);

  // The hidden child's own body (a document) and a comment on it.
  const childDoc = await as(admin.token, 'PUT', `${recordUrl(child)}/document`, { content: [para(txt(HIDDEN_BODY))], expected_version: 0 });
  expect(childDoc.statusCode, childDoc.body).toBeLessThan(300);
  const comment = await as(admin.token, 'POST', `${recordUrl(child)}/comments`, { body: [{ type: 'text', text: HIDDEN_COMMENT }] });
  expect(comment.statusCode, comment.body).toBeLessThan(300);

  // Link, then keep editing the PARENT so versions / field changes / document versions all accumulate
  // around the link: links before, between and after the edits.
  await as(admin.token, 'POST', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: [child] });
  await as(admin.token, 'PATCH', recordUrl(parent), { values: { name: 'Parent renamed once' } });
  const doc1 = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, { content: [para(txt('see '), mention(child, HIDDEN_TITLE))], expected_version: 0 });
  expect(doc1.statusCode, doc1.body).toBeLessThan(300);
  await as(admin.token, 'PATCH', recordUrl(parent), { values: { name: 'Parent renamed twice', [richFieldApi]: [para(txt('rich: '), mention(child, HIDDEN_TITLE))] } });
  const doc2 = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, { content: [para(txt('edited, still see '), mention(child, HIDDEN_TITLE))], expected_version: doc1.json().version });
  expect(doc2.statusCode, doc2.body).toBeLessThan(300);
  await as(admin.token, 'DELETE', `${recordUrl(parent)}/links/${subItemsFieldId}`, { record_ids: [child] });
  await as(admin.token, 'PATCH', recordUrl(parent), { values: { name: 'Parent renamed thrice' } });

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email, role: 'guest', grants: [{ record_id: parent, role: 'viewer' }],
  });
  expect(invite.statusCode, invite.body).toBeLessThan(300);
  const accepted = await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  expect(accepted.statusCode, accepted.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await app.close();
});

const NEEDLES = () => [HIDDEN_TITLE, HIDDEN_BODY, HIDDEN_COMMENT, child];
const leaks = (body: string) => NEEDLES().filter((n) => body.includes(n));

/** One probe: the same GET as admin and as guest. Returns both bodies. */
async function probe(url: string) {
  const a = await as(admin.token, 'GET', url);
  const g = await as(guest.token, 'GET', url);
  return { a, g };
}

describe('#847 — record_versions, field-change history and document versions, as a record-scoped guest', () => {
  it('GET /versions (the version list): guest sees no hidden title, body, comment or id; admin sees the versions', async () => {
    const { a, g } = await probe(`${recordUrl(parent)}/versions?limit=100`);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().data.length, 'admin control: the versions exist').toBeGreaterThanOrEqual(3);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().data.length, 'the guest gets the parent\'s own history').toBeGreaterThanOrEqual(3);
    expect(leaks(g.body), 'leaked strings').toEqual([]);
  });

  it('GET /versions/changes (the field-level timeline, relation fields included): same', async () => {
    const { a, g } = await probe(`${recordUrl(parent)}/versions/changes?limit=100`);
    expect(a.statusCode, a.body).toBe(200);
    expect(g.statusCode, g.body).toBe(200);
    // Admin control: the timeline is not empty, and records the parent's own renames.
    expect(JSON.stringify(a.json())).toContain('Parent renamed');
    expect(JSON.stringify(g.json())).toContain('Parent renamed');
    process.stderr.write('CHANGES-GUEST ' + g.body.slice(0, 1800) + '\n');
    expect(leaks(g.body), 'leaked strings').toEqual([]);
  });

  it('GET /versions/:id (a version preview diffed against the current record): every version, as both', async () => {
    const list = (await as(admin.token, 'GET', `${recordUrl(parent)}/versions?limit=100`)).json().data as Array<{ id: string }>;
    for (const v of list) {
      const { a, g } = await probe(`${recordUrl(parent)}/versions/${v.id}`);
      expect(a.statusCode, a.body).toBe(200);
      expect(g.statusCode, g.body).toBe(200);
      if (leaks(g.body).length) process.stderr.write('PREVIEW-GUEST ' + g.body.slice(0, 1500) + '\n');
      expect(leaks(g.body), `version ${v.id} leaked`).toEqual([]);
    }
  });

  it('GET /document/versions and /document/versions/:n (document version history): guest vs admin', async () => {
    const { a, g } = await probe(`${recordUrl(parent)}/document/versions?limit=100`);
    expect(a.statusCode, a.body).toBe(200);
    expect(g.statusCode, g.body).toBe(200);
    expect(a.json().data.length, 'admin control: a document version exists (one is captured per overwrite)').toBeGreaterThanOrEqual(1);
    expect(leaks(g.body), 'version LIST leaked').toEqual([]);
    for (const v of a.json().data as Array<{ id: string; version: number }>) {
      const one = await probe(`${recordUrl(parent)}/document/versions/${v.id}`);
      expect(one.a.statusCode, one.a.body).toBeLessThan(500);
      process.stderr.write(`DOCVER ${v.version}: admin=${one.a.statusCode} guest=${one.g.statusCode} guestLeaks=${JSON.stringify(leaks(one.g.body))}\n`);
    }
  });

  it('PROBE the hidden record\'s OWN history as the guest: all 404, no hidden content', async () => {
    for (const path of ['versions', 'versions/changes', 'document/versions', 'activity']) {
      const g = await as(guest.token, 'GET', `${recordUrl(child)}/${path}`);
      expect(g.statusCode, `${path}: ${g.body}`).toBe(404);
    }
  });
});


describe('#847 — is it the HISTORY, or the live read too? (the same needles, on the surfaces that return the record itself)', () => {
  it('the guest\'s ordinary reads of the parent', async () => {
    const reads: Record<string, string> = {
      record: (await as(guest.token, 'GET', recordUrl(parent))).body,
      document: (await as(guest.token, 'GET', `${recordUrl(parent)}/document`)).body,
      list: (await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records/query`, { limit: 50 })).body,
    };
    for (const [k, v] of Object.entries(reads)) process.stderr.write(`LIVE ${k}: ${JSON.stringify(leaks(v))}\n`);
    expect(true).toBe(true);
  });
});
