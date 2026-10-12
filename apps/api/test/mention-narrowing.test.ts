import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
/**
 * #857 — a record-mention chip inside rich text must not hand a record-scoped guest the id or
 * title of a record they cannot read (#473: absent from every response body — no chip, no id,
 * no title, no count). Reached the way #845 was: a REAL request as a record-scoped-only guest,
 * a hidden record with a DISTINCTIVE title, then a grep of the response BODY.
 *
 * Every guest assertion has its ADMIN CONTROL (the real mention is still there) and a
 * READABLE-mention control (a record the guest does hold a grant on still renders as a chip).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let tasksDb: string;
let parent: string;
let friend: string;
let child: string;
let richFieldApi: string;
let inviteBody: { notice?: string };

const HIDDEN_TITLE = 'ZEBRA-TITLE hidden sub-item 9f3a';
const FRIEND_TITLE = 'OTTER-TITLE readable friend 31bc';
const PLACEHOLDER = '[restricted]';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recordUrl = (id: string) => `/workspaces/${wsId}/databases/${tasksDb}/records/${id}`;
const mention = (id: string, label: string) => ({ type: 'mention', props: { kind: 'record', id, label } });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const txt = (text: string) => ({ type: 'text', text, styles: {} });
const both = () => [para(txt('hidden: '), mention(child, HIDDEN_TITLE), txt(' friend: '), mention(friend, FRIEND_TITLE))];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'MentOwner');
  guest = await signUpUser(app, 'MentGuest');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '857 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  const rich = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Notes', type: 'rich_text' });
  expect(rich.statusCode, rich.body).toBeLessThan(300);
  richFieldApi = rich.json().apiName ?? rich.json().api_name;

  const mk = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name } })).json().id as string;
  parent = await mk('The visible parent');
  friend = await mk(FRIEND_TITLE);
  child = await mk(HIDDEN_TITLE);

  const doc1 = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, { content: both(), expected_version: 0 });
  expect(doc1.statusCode, doc1.body).toBeLessThan(300);
  // Overwrite with the mentions removed: the captured version still carries them (the preview
  // diff shows them as removed), so both the version preview and ...
  const doc2 = await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, { content: [para(txt('edited, mentions removed'))], expected_version: doc1.json().version });
  // ... a LIVE document that carries them are exercised.
  await as(admin.token, 'PUT', `${recordUrl(parent)}/document`, { content: both(), expected_version: doc2.json().version });
  await as(admin.token, 'PATCH', recordUrl(parent), { values: { name: 'Parent renamed', [richFieldApi]: both() } });
  const c1 = await as(admin.token, 'POST', `${recordUrl(parent)}/comments`, { body: { format: 'blocknote', doc: both() } });
  expect(c1.statusCode, c1.body).toBeLessThan(300);
  const c2 = await as(admin.token, 'POST', `${recordUrl(parent)}/comments`, {
    body: [{ type: 'text', text: 'legacy ' }, { type: 'record', record_id: child, database_id: tasksDb }, { type: 'record', record_id: friend, database_id: tasksDb }],
  });
  expect(c2.statusCode, c2.body).toBeLessThan(300);

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email, role: 'guest', grants: [{ record_id: parent, role: 'commenter' }, { record_id: friend, role: 'viewer' }],
  });
  expect(invite.statusCode, invite.body).toBeLessThan(300);
  inviteBody = invite.json();
  const accepted = await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  expect(accepted.statusCode, accepted.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await app.close();
});

const leaks = (body: string) => [HIDDEN_TITLE, child].filter((n) => body.includes(n));

/** The same GET as admin and as guest, with the three assertions every surface owes. */
async function surface(url: string, opts: { friendChip?: boolean } = {}) {
  const a = await as(admin.token, 'GET', url);
  const g = await as(guest.token, 'GET', url);
  expect(a.statusCode, a.body).toBe(200);
  expect(g.statusCode, g.body).toBe(200);
  // Admin control: the real mention, id and label, is still there.
  expect(a.body, 'admin keeps the real mention (id)').toContain(child);
  expect(a.body, 'admin keeps the real mention (label)').toContain(HIDDEN_TITLE);
  // The guest sees neither.
  expect(leaks(g.body), `guest leaked on ${url}`).toEqual([]);
  expect(g.body, 'a redaction is visible as a redaction').toContain(PLACEHOLDER);
  // A mention of a record the guest CAN read is untouched.
  if (opts.friendChip !== false) expect(g.body, 'readable mention survives').toContain(friend);
  return { a, g };
}

describe('#857 — record-mention chips narrowed for a record-scoped guest', () => {
  it('GET /records/:id (the rich_text field value)', async () => {
    await surface(recordUrl(parent));
  });

  it('GET /records/:id/document', async () => {
    await surface(`${recordUrl(parent)}/document`);
  });

  it('POST /records/query (the list)', async () => {
    const url = `/workspaces/${wsId}/databases/${tasksDb}/records/query`;
    const a = await as(admin.token, 'POST', url, {});
    const g = await as(guest.token, 'POST', url, {});
    expect(a.statusCode, a.body).toBeLessThan(300);
    expect(g.statusCode, g.body).toBeLessThan(300);
    expect(a.body).toContain(HIDDEN_TITLE); // admin control (the hidden record is itself a row)
    expect(leaks(g.body)).toEqual([]);
    expect(g.body).toContain(PLACEHOLDER);
    expect(g.body).toContain(friend);
  });

  it('GET /versions/changes (the field-level timeline)', async () => {
    await surface(`${recordUrl(parent)}/versions/changes?limit=100`);
  });

  it('GET /versions/:id (every version preview)', async () => {
    const list = (await as(admin.token, 'GET', `${recordUrl(parent)}/versions?limit=100`)).json().data as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    let withMention = 0;
    for (const v of list) {
      const a = await as(admin.token, 'GET', `${recordUrl(parent)}/versions/${v.id}`);
      const g = await as(guest.token, 'GET', `${recordUrl(parent)}/versions/${v.id}`);
      expect(g.statusCode, g.body).toBe(200);
      expect(leaks(g.body), `version ${v.id}`).toEqual([]);
      if (a.body.includes(child)) withMention += 1;
    }
    expect(withMention, 'admin control: at least one version carries the mention').toBeGreaterThanOrEqual(1);
  });

  it('GET /document/versions/:id (document version previews)', async () => {
    const list = (await as(admin.token, 'GET', `${recordUrl(parent)}/document/versions?limit=100`)).json().data as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    let withMention = 0;
    for (const v of list) {
      const a = await as(admin.token, 'GET', `${recordUrl(parent)}/document/versions/${v.id}`);
      const g = await as(guest.token, 'GET', `${recordUrl(parent)}/document/versions/${v.id}`);
      expect(g.statusCode, g.body).toBe(200);
      expect(leaks(g.body), `doc version ${v.id}`).toEqual([]);
      if (a.body.includes(child)) withMention += 1;
    }
    expect(withMention).toBeGreaterThanOrEqual(1);
  });

  it('GET /comments — BlockNote and legacy-segment bodies both narrowed', async () => {
    const { a, g } = await surface(`${recordUrl(parent)}/comments`);
    // Two comments, two shapes: the placeholder appears once per redacted chip, identically.
    expect(a.body.split(child).length - 1, 'admin: the id appears in both comment shapes').toBeGreaterThanOrEqual(2);
    expect((g.body.match(/\[restricted\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the placeholder is byte-identical for every redacted mention (names nothing, varies by nothing)', async () => {
    const g = await as(guest.token, 'GET', recordUrl(parent));
    const nodes = JSON.stringify(g.json()).match(/\{"type":"text","text":"\[restricted\]","styles":\{\}\}/g) ?? [];
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(nodes).size, 'one distinct redaction node').toBe(1);
  });

  it('stored content is NOT rewritten: the admin still reads the real mention after the guest read', async () => {
    await as(guest.token, 'GET', recordUrl(parent));
    const a = await as(admin.token, 'GET', recordUrl(parent));
    expect(a.body).toContain(child);
    expect(a.body).toContain(HIDDEN_TITLE);
  });
});

describe('#857 — the surfaces the ticket listed as UNPROBED', () => {
  it('CSV export (a streamed, non-JSON body): guest vs admin', async () => {
    const url = `/workspaces/${wsId}/databases/${tasksDb}/export/csv`;
    const a = await as(admin.token, 'GET', url);
    const g = await as(guest.token, 'GET', url);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.body, 'admin control').toContain(HIDDEN_TITLE);
    expect(g.statusCode, g.body).toBe(200);
    expect(leaks(g.body), 'guest CSV leaked').toEqual([]);
    expect(g.body, 'redaction visible as a redaction').toContain(PLACEHOLDER);
    expect(g.body, 'readable mention survives in the CSV').toContain(friend);
  });

  it('database comments feed', async () => {
    const url = `/workspaces/${wsId}/databases/${tasksDb}/activity/comments`;
    const a = await as(admin.token, 'GET', url);
    const g = await as(guest.token, 'GET', url);
    expect(a.statusCode, a.body).toBe(200);
    expect(g.statusCode, g.body).toBe(200);
    expect(leaks(g.body)).toEqual([]);
  });

  it('search: the hidden title is not findable by the guest (admin control: it is)', async () => {
    const url = `/workspaces/${wsId}/search?q=ZEBRA`;
    const a = await as(admin.token, 'GET', url);
    const g = await as(guest.token, 'GET', url);
    expect(a.body, 'admin control').toContain(HIDDEN_TITLE);
    expect(g.statusCode, g.body).toBeLessThan(500);
    expect(leaks(g.body)).toEqual([]);
  });

  it('notifications: a guest who is a thread participant gets a comment snippet that names no hidden record', async () => {
    // The guest comments first (so they are a participant), then the admin comments with a hidden mention.
    const first = await as(guest.token, 'POST', `${recordUrl(parent)}/comments`, { body: [{ type: 'text', text: 'guest here' }] });
    expect(first.statusCode, first.body).toBeLessThan(300);
    const second = await as(admin.token, 'POST', `${recordUrl(parent)}/comments`, { body: { format: 'blocknote', doc: [para(txt('see '), mention(child, HIDDEN_TITLE))] } });
    expect(second.statusCode, second.body).toBeLessThan(300);
    const g = await as(guest.token, 'GET', `/workspaces/${wsId}/notifications`);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().data?.length ?? g.json().length, 'the guest was notified (not vacuous)').toBeGreaterThanOrEqual(1);
    expect(leaks(g.body)).toEqual([]);
  });
});

describe('#857 — the grantor is told their text reads differently to a record-scoped guest', () => {
  it('a record-scoped invite carries the notice; a database-scoped one does not', async () => {
    expect(inviteBody.notice, 'record-scoped invite names the redaction').toContain(PLACEHOLDER);
    const other = await signUpUser(app, 'MentGuest2');
    const dbInvite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: other.email, role: 'guest', grants: [{ database_id: tasksDb, role: 'viewer' }],
    });
    expect(dbInvite.statusCode, dbInvite.body).toBeLessThan(300);
    expect(dbInvite.json().notice, 'no record scope, nothing to disclose').toBeUndefined();
  });

  it('POST /grants on a record carries the notice; on a database it does not', async () => {
    const who = await signUpUser(app, 'MentGuest3');
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    expect(members).toBeTruthy();
    const inv = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: who.email, role: 'guest', grants: [{ database_id: tasksDb, role: 'viewer' }] });
    await as(who.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const me = (await as(who.token, 'GET', '/me')).json();
    const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: me.id, record_id: parent, role: 'viewer' });
    expect(rec.statusCode, rec.body).toBeLessThan(300);
    expect(rec.json().notice).toContain(PLACEHOLDER);
    const db = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: me.id, database_id: tasksDb, role: 'viewer' });
    expect(db.statusCode, db.body).toBeLessThan(300);
    expect(db.json().notice).toBeUndefined();
  });
});
