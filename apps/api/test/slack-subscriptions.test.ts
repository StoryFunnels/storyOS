import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { databases, memberships, records, slackSubscriptions, spaces } from '../src/db/schema';
import { SlackSubscriptionsService } from '../src/integrations/slack-subscriptions.service';
import { ExternalIdUpsertService } from '../src/migration-framework/external-id-upsert.service';
import { runAsImportRun } from '../src/common/import-run-context';
import type { DomainEvent } from '../src/events/domain-events.service';

/**
 * Ticket #1377 - Slack channel subscriptions. Everything here runs against a FAKE Slack (the service's fetcher is swapped), never a
 * real one. The access tests use all four kinds of person ADR-0018 says a test needs: an admin, a plain member who holds no grant on
 * the restricted thing, a guest, and an admin who is later demoted or removed (the "creator lost access" cases).
 */
let app: NestFastifyApplication;
let svc: SlackSubscriptionsService;
let db: Db;
let owner: { token: string; email: string };
let ws: string;
let member: Person;
let memberNoGrant: Person;
let guest: Person;
let spaceId: string;
let restrictedSpaceId: string;
let issuesDb: string;
let statusApi: string;
let statusOptions: Record<string, string>;
let closedDbInOpenSpace: string;
let secretDb: string;

interface Posted { channel: string | undefined; text: string }
let posted: Posted[] = [];
let failNext = 0;
let failAlways = false;

const as = (who: { token: string }, method: string, url: string, payload?: unknown) => call(app, who.token, method, url, payload);
const subsUrl = () => `/workspaces/${ws}/integrations/slack/subscriptions`;

async function newDatabase(name: string, inSpace: string, withStatus = false) {
  const res = await as(owner, 'POST', `/workspaces/${ws}/databases`, { space_id: inSpace, name });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  if (!withStatus) return { id };
  const f = await as(owner, 'POST', `/workspaces/${ws}/databases/${id}/fields`, {
    display_name: 'Stage',
    type: 'workflow',
    options: [{ label: 'Todo' }, { label: 'Doing' }, { label: 'Done' }],
  });
  expect(f.statusCode, f.body).toBe(201);
  const options: Record<string, string> = {};
  for (const o of f.json().options as Array<{ id: string; label: string }>) options[o.label] = o.id;
  return { id, statusApi: f.json().apiName as string, options };
}

const createRecord = (dbId: string, values: Record<string, unknown>) => as(owner, 'POST', `/workspaces/${ws}/databases/${dbId}/records`, { values });
const subscribe = (body: Record<string, unknown>, who: { token: string } = owner) => as(who, 'POST', subsUrl(), body);

async function settle() {
  await svc.settle();
}
const clean = async () => {
  await db.delete(slackSubscriptions).where(eq(slackSubscriptions.workspaceId, ws));
  posted = [];
  failNext = 0;
  failAlways = false;
};

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(SlackSubscriptionsService);
  db = app.get<Db>(DB);
  svc.sendIntervalMs = 0;
  svc.retryDelaysMs = [0, 0, 0];
  svc.slack.fetcher = async (_url, init) => {
    const body = JSON.parse(init.body) as { channel?: string; text: string };
    if (failAlways || failNext > 0) {
      failNext = Math.max(0, failNext - 1);
      return { status: 200, text: async () => JSON.stringify({ ok: false, error: 'channel_not_found' }) };
    }
    posted.push({ channel: body.channel, text: body.text });
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  owner = await signUpUser(app, 'Subs Owner');
  ws = (await as(owner, 'POST', '/workspaces', { name: 'Slack Subs WS' })).json().id;
  spaceId = ((await as(owner, 'GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
  restrictedSpaceId = (await as(owner, 'POST', `/workspaces/${ws}/spaces`, { name: 'Restricted space' })).json().id;
  await setRestricted(app, owner.token, ws, 'space', restrictedSpaceId);

  const issues = await newDatabase('Issues', spaceId, true);
  issuesDb = issues.id;
  statusApi = issues.statusApi!;
  statusOptions = issues.options!;
  closedDbInOpenSpace = (await newDatabase('Closed DB', spaceId, true)).id;
  await setRestricted(app, owner.token, ws, 'database', closedDbInOpenSpace);
  secretDb = (await newDatabase('Secret DB', restrictedSpaceId, true)).id;

  member = await joinAs(app, owner.token, ws, 'Subs Member', 'member');
  memberNoGrant = await joinAs(app, owner.token, ws, 'Subs NoGrant', 'member');
  guest = await joinAs(app, owner.token, ws, 'Subs Guest', 'guest', [{ space_id: spaceId, role: 'viewer' }]);

  const saved = await as(owner, 'POST', `/workspaces/${ws}/integrations/slack`, { bot_token: 'xoxb-test-token', default_channel: 'general' });
  expect(saved.statusCode, saved.body).toBe(201);
}, 240_000);
afterAll(async () => {
  await app.close();
});
beforeEach(clean);

describe('who may manage subscriptions: admins only, and nobody learns what exists', () => {
  it('a member, a member with no grant on the restricted space, and a guest are all refused on every route, and the body names nothing', async () => {
    const mine = await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    expect(mine.statusCode, mine.body).toBe(201);
    const id = mine.json().id as string;
    for (const who of [member, memberNoGrant, guest]) {
      const list = await as(who, 'GET', subsUrl());
      expect(list.statusCode, `list as ${who.email}: ${list.body}`).toBe(403);
      expect(list.body).not.toContain('Issues');
      expect(list.body).not.toContain('eng');
      expect((await subscribe({ database_id: issuesDb, channel: 'ops', events: ['created'] }, who)).statusCode).toBe(403);
      expect((await subscribe({ space_id: restrictedSpaceId, channel: 'ops', events: ['created'], acknowledge_restricted: true }, who)).statusCode).toBe(403);
      expect((await as(who, 'PATCH', `${subsUrl()}/${id}`, { events: ['commented'] })).statusCode).toBe(403);
      expect((await as(who, 'DELETE', `${subsUrl()}/${id}`)).statusCode).toBe(403);
    }
    // MUST KEEP WORKING: the admin sees it and the refused calls changed nothing.
    const list = await as(owner, 'GET', subsUrl());
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({ channel: 'eng', events: ['created'], scope: { kind: 'database', name: 'Issues' }, closed: false });
  });

  it('a subscription of another workspace is a 404, not a 403 and not a delete', async () => {
    const other = await signUpUser(app, 'Other Owner');
    const otherWs = (await as(other, 'POST', '/workspaces', { name: 'Other WS' })).json().id as string;
    await as(other, 'POST', `/workspaces/${otherWs}/integrations/slack`, { bot_token: 'xoxb-other', default_channel: 'general' });
    const otherSpace = ((await as(other, 'GET', `/workspaces/${otherWs}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const theirs = await as(other, 'POST', subsUrl().replace(ws, otherWs), { space_id: otherSpace, channel: 'x', events: ['created'] });
    expect(theirs.statusCode, theirs.body).toBe(201);
    const otherDb = (await as(other, 'POST', `/workspaces/${otherWs}/databases`, { space_id: otherSpace, name: 'Theirs' })).json().id as string;
    // Mine cannot point at their space or their database ...
    expect((await subscribe({ space_id: otherSpace, channel: 'eng', events: ['created'] })).statusCode).toBe(404);
    expect((await subscribe({ database_id: otherDb, channel: 'eng', events: ['created'] })).statusCode).toBe(404);
    // ... and cannot reach their row through my workspace's route.
    expect((await as(owner, 'DELETE', `${subsUrl()}/${theirs.json().id}`)).statusCode).toBe(404);
    expect((await as(owner, 'PATCH', `${subsUrl()}/${theirs.json().id}`, { events: ['commented'] })).statusCode).toBe(404);
    expect(((await as(other, 'GET', subsUrl().replace(ws, otherWs))).json().data as unknown[]).length).toBe(1);
  });

  it('an admin-scoped token lists, creates, changes and deletes; a read-scoped one (or a write-scoped one) of the same admin can do none of it, the list included (#1049)', async () => {
    const me = (await as(owner, 'GET', '/me')).json();
    const mint = async (scope: 'read' | 'write' | 'admin') => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: authed(owner.token), payload: { workspace_id: ws, name: `subs-${scope}`, scope } });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().token as string;
    };
    void me;
    const readToken = await mint('read');
    const writeToken = await mint('write');
    const adminToken = await mint('admin');
    const created = await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    const id = created.json().id as string;
    for (const t of [readToken, writeToken]) expect((await call(app, t, 'GET', subsUrl())).statusCode).toBe(403);
    expect((await call(app, adminToken, 'GET', subsUrl())).statusCode).toBe(200);
    expect((await call(app, writeToken, 'POST', subsUrl(), { database_id: issuesDb, channel: 'ops', events: ['created'] })).statusCode).toBe(403);
    expect((await call(app, readToken, 'POST', subsUrl(), { database_id: issuesDb, channel: 'ops', events: ['created'] })).statusCode).toBe(403);
    expect((await call(app, readToken, 'PATCH', `${subsUrl()}/${id}`, { events: ['commented'] })).statusCode).toBe(403);
    expect((await call(app, readToken, 'DELETE', `${subsUrl()}/${id}`)).statusCode).toBe(403);
    expect((await call(app, adminToken, 'POST', subsUrl(), { database_id: issuesDb, channel: 'ops', events: ['created'] })).statusCode).toBe(201);
  });
});

describe('creating one: input is rejected in the controller, not by a constraint', () => {
  it('exactly one of space_id / database_id, at least one known event, a real target', async () => {
    expect((await subscribe({ channel: 'eng', events: ['created'] })).statusCode).toBe(422);
    expect((await subscribe({ space_id: spaceId, database_id: issuesDb, channel: 'eng', events: ['created'] })).statusCode).toBe(422);
    expect((await subscribe({ database_id: issuesDb, channel: 'eng', events: [] })).statusCode).toBe(422);
    expect((await subscribe({ database_id: issuesDb, channel: 'eng', events: ['deleted'] })).statusCode).toBe(422);
    expect((await subscribe({ database_id: '00000000-0000-4000-8000-000000000000', channel: 'eng', events: ['created'] })).statusCode).toBe(404);
    expect((await subscribe({ space_id: '00000000-0000-4000-8000-000000000000', channel: 'eng', events: ['created'] })).statusCode).toBe(404);
    expect((await as(owner, 'GET', subsUrl())).json().data).toHaveLength(0);
  });

  it('no private channels, direct messages or people; a channel name or a C id is fine and a leading # is dropped', async () => {
    for (const bad of ['G0123456789', 'D0123456789', 'U0123456789', 'W0123456789', 'Has Spaces', '@someone']) {
      const res = await subscribe({ database_id: issuesDb, channel: bad, events: ['created'] });
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(422);
    }
    const ok = await subscribe({ database_id: issuesDb, channel: '#engineering', events: ['created'] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().channel).toBe('engineering');
    expect((await subscribe({ database_id: issuesDb, channel: 'C0123ABCDEF', events: ['created'] })).statusCode).toBe(201);
  });

  it('the same channel twice on one target is a 409, and a second channel is fine', async () => {
    expect((await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] })).statusCode).toBe(201);
    expect((await subscribe({ database_id: issuesDb, channel: 'eng', events: ['commented'] })).statusCode).toBe(409);
    expect((await subscribe({ database_id: issuesDb, channel: 'ops', events: ['commented'] })).statusCode).toBe(201);
  });

  it('with no Slack connection it says so; a webhook-only workspace fixes the channel, so naming one is refused', async () => {
    const lone = await signUpUser(app, 'Lone Owner');
    const loneWs = (await as(lone, 'POST', '/workspaces', { name: 'Lone WS' })).json().id as string;
    const loneSpace = ((await as(lone, 'GET', `/workspaces/${loneWs}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const url = subsUrl().replace(ws, loneWs);
    const none = await as(lone, 'POST', url, { space_id: loneSpace, channel: 'eng', events: ['created'] });
    expect(none.statusCode, none.body).toBe(422);
    expect(none.body).toContain('Connect Slack');
    const hook = await as(lone, 'POST', `/workspaces/${loneWs}/integrations/slack`, { webhook_url: 'https://hooks.slack.com/services/T000/B000/XXXX' });
    expect(hook.statusCode, hook.body).toBe(201);
    expect((await as(lone, 'POST', url, { space_id: loneSpace, channel: 'eng', events: ['created'] })).statusCode).toBe(422);
    const noChannel = await as(lone, 'POST', url, { space_id: loneSpace, events: ['created'] });
    expect(noChannel.statusCode, noChannel.body).toBe(201);
    expect(noChannel.json().channel).toBeNull();
  });

  it('a restricted space or database needs acknowledge_restricted: its titles go to a channel StoryOS does not control', async () => {
    for (const target of [{ space_id: restrictedSpaceId }, { database_id: closedDbInOpenSpace }, { database_id: secretDb }]) {
      const refused = await subscribe({ ...target, channel: 'eng', events: ['created'] });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.body).toContain('acknowledge_restricted');
    }
    const ok = await subscribe({ database_id: closedDbInOpenSpace, channel: 'eng', events: ['created'], acknowledge_restricted: true });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().closed).toBe(true);
    // An open target is unaffected by the flag either way.
    expect((await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] })).statusCode).toBe(201);
  });

  it('personal-space content is never subscribable: the owner is told why, anyone else gets a 404 (an admin has no bypass there)', async () => {
    const mine = (await as(member, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id as string;
    const res = await subscribe({ space_id: mine, channel: 'eng', events: ['created'] });
    expect(res.statusCode, res.body).toBe(404);
    const ownerPersonal = (await as(owner, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id as string;
    const own = await subscribe({ space_id: ownerPersonal, channel: 'eng', events: ['created'] });
    expect(own.statusCode, own.body).toBe(422);
    expect(own.body).toContain('Personal space');
  });
});

describe('what gets posted, and what never does', () => {
  it('creating, changing the status and commenting each post ONE message; removing the subscription stops them', async () => {
    const sub = await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created', 'status_changed', 'commented'] });
    expect(sub.statusCode, sub.body).toBe(201);

    const rec = await createRecord(issuesDb, { name: 'Fix the login bug', [statusApi]: statusOptions['Todo'] });
    expect(rec.statusCode, rec.body).toBe(201);
    const recordId = rec.json().id as string;
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.channel).toBe('eng');
    expect(posted[0]!.text).toContain('Fix the login bug');
    expect(posted[0]!.text).toContain('Todo');
    expect(posted[0]!.text).toContain('Subs Owner');
    expect(posted[0]!.text).toContain(`/r/${recordId}`);
    expect(posted[0]!.text).toContain('created');

    const patch = await as(owner, 'PATCH', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}`, { values: { [statusApi]: statusOptions['Doing'] } });
    expect(patch.statusCode, patch.body).toBe(200);
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.text).toContain('Todo');
    expect(posted[1]!.text).toContain('Doing');
    expect(posted[1]!.text).toContain('changed the status');

    const cmt = await as(owner, 'POST', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}/comments`, { body: [{ type: 'text', text: 'COMMENT-BODY-XYZ' }] });
    expect(cmt.statusCode, cmt.body).toBe(201);
    await settle();
    expect(posted).toHaveLength(3);
    expect(posted[2]!.text).toContain('commented on');
    expect(posted[2]!.text).toContain('Doing');

    // Delivery is counted on the subscription.
    const row = (await as(owner, 'GET', subsUrl())).json().data[0];
    expect(row).toMatchObject({ sent_count: 3, failed_count: 0, last_error: null });

    // Removing it stops the posts.
    expect((await as(owner, 'DELETE', `${subsUrl()}/${sub.json().id}`)).statusCode).toBe(200);
    await createRecord(issuesDb, { name: 'After removal' });
    await as(owner, 'PATCH', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}`, { values: { [statusApi]: statusOptions['Done'] } });
    await as(owner, 'POST', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}/comments`, { body: [{ type: 'text', text: 'silent' }] });
    await settle();
    expect(posted).toHaveLength(3);
  });

  it('a message carries the title, state, actor and link and NO field value, description or comment text', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created', 'status_changed', 'commented'] });
    const rec = await createRecord(issuesDb, { name: 'Quarterly numbers', [statusApi]: statusOptions['Todo'] });
    const recordId = rec.json().id as string;
    await as(owner, 'PATCH', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}`, { values: { [statusApi]: statusOptions['Done'] } });
    await as(owner, 'POST', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}/comments`, { body: [{ type: 'text', text: 'COMMENT-BODY-XYZ salary is 90000' }] });
    await settle();
    expect(posted).toHaveLength(3);
    for (const p of posted) {
      expect(p.text).not.toContain('COMMENT-BODY-XYZ');
      expect(p.text).not.toContain('salary');
      expect(p.text).not.toContain('90000');
    }
  });

  it('a title cannot ping the channel or hide a link: <!channel>, <@U123> and <https://evil|Click> arrive as literal text', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    await createRecord(issuesDb, { name: '<!channel> <@U123ABC> <https://evil.example|Click here>' });
    await settle();
    expect(posted).toHaveLength(1);
    const text = posted[0]!.text;
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123ABC>');
    expect(text).not.toContain('<https://evil.example');
    expect(text).toContain('&lt;!channel&gt;');
  });

  it('only the events the subscription names post', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['commented'] });
    const rec = await createRecord(issuesDb, { name: 'Only comments', [statusApi]: statusOptions['Todo'] });
    const recordId = rec.json().id as string;
    await as(owner, 'PATCH', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}`, { values: { [statusApi]: statusOptions['Doing'] } });
    await settle();
    expect(posted).toHaveLength(0);
    await as(owner, 'POST', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}/comments`, { body: [{ type: 'text', text: 'hi' }] });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('commented');
  });

  it('a change to another field is not a status change', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['status_changed'] });
    const rec = await createRecord(issuesDb, { name: 'Rename me', [statusApi]: statusOptions['Todo'] });
    await as(owner, 'PATCH', `/workspaces/${ws}/databases/${issuesDb}/records/${rec.json().id}`, { values: { name: 'Renamed' } });
    await settle();
    expect(posted).toHaveLength(0);
  });

  it('the title is the version a NARROWED reader sees (title_local), never the full one: derived values of a closed database do not leave', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['commented'] });
    const rec = await createRecord(issuesDb, { name: 'Deal with Acme' });
    const recordId = rec.json().id as string;
    await db.update(records).set({ title: 'Deal with Acme (margin 41%)', titleLocal: 'Deal with Acme (—)' }).where(eq(records.id, recordId));
    await as(owner, 'POST', `/workspaces/${ws}/databases/${issuesDb}/records/${recordId}/comments`, { body: [{ type: 'text', text: 'x' }] });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('Deal with Acme (—)');
    expect(posted[0]!.text).not.toContain('41%');
  });

  it('via agent: a write whose source is agent says so, naming the member and never an AI as the actor', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    const rec = await createRecord(issuesDb, { name: 'Agent made this' });
    await settle();
    posted = [];
    const ownerId = (await as(owner, 'GET', '/me')).json().id as string;
    await svc.onRecordEvent({ type: 'record_created', workspaceId: ws, databaseId: issuesDb, recordId: rec.json().id, actorId: ownerId, depth: 0, source: 'agent', agentName: 'Tyron', eventId: 'agent-1' });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('via agent');
    expect(posted[0]!.text).toContain('Subs Owner');
    expect(posted[0]!.text).not.toContain('Tyron');
  });
});

describe('scope: a space covers its databases, and one post per channel', () => {
  it('a space subscription covers a database in it', async () => {
    await subscribe({ space_id: spaceId, channel: 'eng', events: ['created'] });
    await createRecord(issuesDb, { name: 'Covered by the space' });
    await settle();
    expect(posted).toHaveLength(1);
  });

  it('a database-level and a space-level subscription on the SAME channel post once, not twice', async () => {
    await subscribe({ space_id: spaceId, channel: 'eng', events: ['created'] });
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    await createRecord(issuesDb, { name: 'Once' });
    await settle();
    expect(posted).toHaveLength(1);
  });

  it('the database-level one WINS: if it leaves an event out, the space-level one does not post it for that channel', async () => {
    await subscribe({ space_id: spaceId, channel: 'eng', events: ['created', 'commented'] });
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['commented'] });
    await createRecord(issuesDb, { name: 'Database narrows it' });
    await settle();
    expect(posted).toHaveLength(0);
  });

  it('different channels each get their own post', async () => {
    await subscribe({ space_id: spaceId, channel: 'eng', events: ['created'] });
    await subscribe({ database_id: issuesDb, channel: 'ops', events: ['created'] });
    await createRecord(issuesDb, { name: 'Two rooms' });
    await settle();
    expect(posted.map((p) => p.channel).sort()).toEqual(['eng', 'ops']);
  });

  it('a space subscription does NOT cover a database that is itself restricted; a subscription of its own, acknowledged, does', async () => {
    await subscribe({ space_id: spaceId, channel: 'eng', events: ['created'] });
    await createRecord(closedDbInOpenSpace, { name: 'CLOSED-TITLE-ONE' });
    await settle();
    expect(posted).toHaveLength(0);
    await subscribe({ database_id: closedDbInOpenSpace, channel: 'eng', events: ['created'], acknowledge_restricted: true });
    await createRecord(closedDbInOpenSpace, { name: 'CLOSED-TITLE-TWO' });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('CLOSED-TITLE-TWO');
  });

  it('a restricted SPACE named on purpose posts for its databases', async () => {
    await subscribe({ space_id: restrictedSpaceId, channel: 'eng', events: ['created'], acknowledge_restricted: true });
    await createRecord(secretDb, { name: 'In the restricted space' });
    await settle();
    expect(posted).toHaveLength(1);
  });
});

describe('system databases (the member directory, the agent runtime) are never posted', () => {
  it('a database-level subscription on one is refused, and a space subscription over one skips it at emit time', async () => {
    const ensured = (await as(owner, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
    const sysDb = ensured.agentsDb.id as string;
    const sys = await db.query.databases.findFirst({ where: eq(databases.id, sysDb) });
    expect(sys?.isSystem).toBe(true);
    const refused = await subscribe({ database_id: sysDb, channel: 'eng', events: ['created'], acknowledge_restricted: true });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain('System databases');

    const space = await db.query.spaces.findFirst({ where: eq(spaces.id, sys!.spaceId) });
    const sub = await subscribe({ space_id: sys!.spaceId, channel: 'eng', events: ['created'], acknowledge_restricted: Boolean(space?.restricted) });
    expect(sub.statusCode, sub.body).toBe(201);
    const [rec] = await db.insert(records).values({ databaseId: sysDb, title: 'Run of the agent', values: {} }).returning();
    const ev = (eventId: string): DomainEvent => ({ type: 'record_created', workspaceId: ws, databaseId: sysDb, recordId: rec!.id, actorId: null, depth: 0, eventId });
    await svc.onRecordEvent(ev('sys-1'));
    await settle();
    expect(posted).toHaveLength(0);
    // control: the same event posts once the database is an ordinary one, so the system flag was the only thing in the way
    await db.update(databases).set({ isSystem: false, systemKey: null }).where(eq(databases.id, sysDb));
    try {
      await svc.onRecordEvent(ev('sys-2'));
      await settle();
      expect(posted).toHaveLength(1);
    } finally {
      await db.update(databases).set({ isSystem: true, systemKey: sys!.systemKey }).where(eq(databases.id, sysDb));
    }
  });
});

describe('suppressed at emit time: the creator, personal space, trash, deleted containers', () => {
  async function adminWithSubscription(name: string, channel: string) {
    const admin = await joinAs(app, owner.token, ws, name, 'admin');
    const sub = await subscribe({ database_id: issuesDb, channel, events: ['created'] }, admin);
    expect(sub.statusCode, sub.body).toBe(201);
    const membership = await db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, ws), eq(memberships.userId, admin.id)) });
    return { admin, id: sub.json().id as string, membershipId: membership!.id };
  }

  it('an admin who is DEMOTED stops posting, is flagged visibly, and a current admin taking it over clears the flag', async () => {
    const { id, membershipId } = await adminWithSubscription('Demoted Admin', 'eng');
    await createRecord(issuesDb, { name: 'Before' });
    await settle();
    expect(posted).toHaveLength(1);

    const demote = await as(owner, 'PATCH', `/workspaces/${ws}/members/${membershipId}`, { role: 'member' });
    expect(demote.statusCode, demote.body).toBe(200);
    posted = [];
    await createRecord(issuesDb, { name: 'After demotion' });
    await settle();
    expect(posted).toHaveLength(0);
    const flagged = (await as(owner, 'GET', subsUrl())).json().data.find((s: { id: string }) => s.id === id);
    expect(flagged.needs_attention).toBe('creator_not_admin');

    const take = await as(owner, 'PATCH', `${subsUrl()}/${id}`, { events: ['created'] });
    expect(take.statusCode, take.body).toBe(200);
    expect(take.json().needs_attention).toBeNull();
    expect(take.json().created_by).not.toBe(flagged.created_by);
    await createRecord(issuesDb, { name: 'After take-over' });
    await settle();
    expect(posted).toHaveLength(1);
  });

  it('an admin who LEFT the workspace stops posting and is flagged creator_left', async () => {
    const { id, membershipId } = await adminWithSubscription('Leaver Admin', 'eng');
    expect((await as(owner, 'DELETE', `/workspaces/${ws}/members/${membershipId}`)).statusCode).toBe(200);
    await createRecord(issuesDb, { name: 'After they left' });
    await settle();
    expect(posted).toHaveLength(0);
    const flagged = (await as(owner, 'GET', subsUrl())).json().data.find((s: { id: string }) => s.id === id);
    expect(flagged.needs_attention).toBe('creator_left');
  });

  it('one subscription whose creator is gone does not silence the others in the same workspace', async () => {
    const { membershipId } = await adminWithSubscription('Gone Admin', 'eng');
    await subscribe({ database_id: issuesDb, channel: 'ops', events: ['created'] });
    await as(owner, 'DELETE', `/workspaces/${ws}/members/${membershipId}`);
    await createRecord(issuesDb, { name: 'Still posting to ops' });
    await settle();
    expect(posted.map((p) => p.channel)).toEqual(['ops']);
  });

  async function createRecordRaw(dbId: string) {
    const rec = await createRecord(dbId, { name: 'Raw' });
    await settle();
    posted = [];
    return rec.json().id as string;
  }

  it('a record in a PERSONAL space posts nothing (the guard is at emit time, not only at create)', async () => {
    const extra = await newDatabase('Soon personal', spaceId, true);
    await subscribe({ database_id: extra.id, channel: 'eng', events: ['created'] });
    const recordId = await createRecordRaw(extra.id);
    const ev = (eventId: string): DomainEvent => ({ type: 'record_created', workspaceId: ws, databaseId: extra.id, recordId, actorId: member.id, depth: 0, eventId });
    await db.update(spaces).set({ personal: true, ownerUserId: memberNoGrant.id }).where(eq(spaces.id, spaceId));
    try {
      await svc.onRecordEvent(ev('personal-1'));
      await settle();
      expect(posted).toHaveLength(0);
    } finally {
      await db.update(spaces).set({ personal: false, ownerUserId: null }).where(eq(spaces.id, spaceId));
    }
    await svc.onRecordEvent(ev('personal-2'));
    await settle();
    expect(posted).toHaveLength(1); // the same event DOES post once the space is ordinary again: the guard was the only thing in the way
  });

  it('a trashed record, a deleted database and a deleted space post nothing', async () => {
    const extra = await newDatabase('Trash target', spaceId, true);
    await subscribe({ database_id: extra.id, channel: 'eng', events: ['created', 'commented'] });
    const recordId = await createRecordRaw(extra.id);
    expect((await as(owner, 'DELETE', `/workspaces/${ws}/databases/${extra.id}/records/${recordId}`)).statusCode).toBe(200);
    await settle();
    posted = [];
    const ev = (id: string): DomainEvent => ({ type: 'record_created', workspaceId: ws, databaseId: extra.id, recordId: id, actorId: member.id, depth: 0, eventId: `t-${id}` });
    await svc.onRecordEvent(ev(recordId));
    await settle();
    expect(posted, 'trashed record').toHaveLength(0);

    const live = await createRecordRaw(extra.id);
    const gone = await as(owner, 'DELETE', `/workspaces/${ws}/databases/${extra.id}`, { confirm: 'Trash target' });
    expect(gone.statusCode, gone.body).toBe(200);
    // the delete is a soft delete (the row stays, marked), so this proves the EMIT-time guard and not just the cascade
    expect((await db.query.databases.findFirst({ where: eq(databases.id, extra.id) }))?.deletedAt).toBeTruthy();
    // the record was trashed with its database; bring it back so only the container guard stands in the way
    await db.update(records).set({ deletedAt: null }).where(eq(records.id, live));
    await svc.onRecordEvent(ev(live));
    await settle();
    expect(posted, 'deleted database').toHaveLength(0);
  });

  it('a space that is deleted posts nothing for its databases', async () => {
    const space = (await as(owner, 'POST', `/workspaces/${ws}/spaces`, { name: 'Doomed space' })).json().id as string;
    const extra = await newDatabase('In doomed', space, true);
    await subscribe({ space_id: space, channel: 'eng', events: ['created'] });
    const recordId = await createRecordRaw(extra.id);
    const gone = await as(owner, 'DELETE', `/workspaces/${ws}/spaces/${space}`, { confirm: 'Doomed space' });
    expect(gone.statusCode, gone.body).toBe(200);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space) }))?.deletedAt).toBeTruthy();
    // the database and its record went with the space; bring both back so only the SPACE guard stands in the way
    await db.update(databases).set({ deletedAt: null }).where(eq(databases.id, extra.id));
    await db.update(records).set({ deletedAt: null }).where(eq(records.id, recordId));
    await svc.onRecordEvent({ type: 'record_created', workspaceId: ws, databaseId: extra.id, recordId, actorId: member.id, depth: 0, eventId: 'doomed' });
    await settle();
    expect(posted).toHaveLength(0);
  });
});

describe('an import is not news', () => {
  const stage = (api: string, label: string) => ({ [api]: statusOptions[label] });
  const base = (recordId: string, extra: Partial<DomainEvent>): DomainEvent => ({ type: 'record_created', workspaceId: ws, databaseId: issuesDb, recordId, actorId: null, depth: 0, ...extra });

  it('importing N records posts 0 created messages, through the real import path', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created', 'status_changed'] });
    const upsert = app.get(ExternalIdUpsertService);
    const membership = (await db.query.memberships.findFirst({ where: eq(memberships.workspaceId, ws) }))!;
    for (let i = 0; i < 6; i += 1) {
      await upsert.upsert(membership as never, issuesDb, 'name', `Imported ${i}`, { ...stage(statusApi, 'Todo') }, membership.userId, { source: 'import' });
    }
    await settle();
    expect(posted).toHaveLength(0);
    // A FULL read that changes the status of mirrored records posts nothing either (it touches every record).
    await upsert.upsert(membership as never, issuesDb, 'name', 'Imported 0', { ...stage(statusApi, 'Done') }, membership.userId, { source: 'import' });
    await settle();
    expect(posted).toHaveLength(0);
  });

  it('an INCREMENTAL read posts the status change it carries, but still no created message', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created', 'status_changed'] });
    const upsert = app.get(ExternalIdUpsertService);
    const membership = (await db.query.memberships.findFirst({ where: eq(memberships.workspaceId, ws) }))!;
    await upsert.upsert(membership as never, issuesDb, 'name', 'Mirrored issue', { ...stage(statusApi, 'Todo') }, membership.userId, { source: 'import' });
    await settle();
    expect(posted).toHaveLength(0);
    await runAsImportRun(() => upsert.upsert(membership as never, issuesDb, 'name', 'Mirrored issue', { ...stage(statusApi, 'Doing') }, membership.userId, { source: 'import' }), 'incremental');
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('Doing');
    expect(posted[0]!.text).toContain('via sync');
    await runAsImportRun(() => upsert.upsert(membership as never, issuesDb, 'name', 'Brand new from incremental', {}, membership.userId, { source: 'import' }), 'incremental');
    await settle();
    expect(posted).toHaveLength(1); // a record created by an import never posts, incremental or not
  });

  it('the event stamps decide it (unit): import full/incremental x created/status_changed', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created', 'status_changed'] });
    const rec = await createRecord(issuesDb, { name: 'Probe', [statusApi]: statusOptions['Todo'] });
    await settle();
    posted = [];
    const f = (await db.query.fields.findMany({ where: (t, { eq: e }) => e(t.databaseId, issuesDb) })).find((x) => x.type === 'workflow')!;
    const changed = { changedFieldIds: [f.id], changedValues: { [f.id]: { from: statusOptions['Todo'], to: statusOptions['Doing'] } } };
    const id = rec.json().id as string;
    await svc.onRecordEvent(base(id, { importRun: 'full', eventId: 'a' }));
    await svc.onRecordEvent(base(id, { importRun: 'incremental', eventId: 'b' }));
    await svc.onRecordEvent(base(id, { type: 'record_updated', importRun: 'full', eventId: 'c', ...changed }));
    await settle();
    expect(posted).toHaveLength(0);
    await svc.onRecordEvent(base(id, { type: 'record_updated', importRun: 'incremental', eventId: 'd', ...changed }));
    await svc.onRecordEvent(base(id, { type: 'record_updated', importRun: null, eventId: 'e', ...changed }));
    await settle();
    expect(posted).toHaveLength(2);
  });
});

describe('delivery: paced, coalesced, retried, counted, and it never blocks a write', () => {
  it('a burst is folded into ONE line that says how many, not dropped and not a message each', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    svc.coalesceAfter = 3;
    let release!: () => void;
    svc.deliveryGate = new Promise<void>((r) => (release = r));
    try {
      for (let i = 0; i < 9; i += 1) expect((await createRecord(issuesDb, { name: `Burst ${i}` })).statusCode).toBe(201);
      // every handler has queued its message; nothing was sent while the gate was closed
      await new Promise((r) => setTimeout(r, 300));
      expect(posted).toHaveLength(0);
      release();
      await settle();
    } finally {
      svc.coalesceAfter = 8;
      svc.deliveryGate = Promise.resolve();
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('9 more updates');
    for (let i = 0; i < 9; i += 1) expect(posted[0]!.text).not.toContain(`Burst ${i}`);
  });

  it('a post that fails is retried and then goes through, once', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    failNext = 2;
    expect((await createRecord(issuesDb, { name: 'Flaky' })).statusCode).toBe(201);
    await settle();
    expect(posted).toHaveLength(1);
    const row = (await as(owner, 'GET', subsUrl())).json().data[0];
    expect(row).toMatchObject({ sent_count: 1, failed_count: 0 });
  });

  it('a post that never works is counted with Slack\'s error code on the subscription, and the record write still succeeded', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    failAlways = true;
    const res = await createRecord(issuesDb, { name: 'Written anyway' });
    expect(res.statusCode, res.body).toBe(201);
    await settle();
    const row = (await as(owner, 'GET', subsUrl())).json().data[0];
    expect(row.failed_count).toBe(1);
    expect(row.sent_count).toBe(0);
    expect(row.last_error).toContain('channel_not_found');
    expect(JSON.stringify(row)).not.toContain('xoxb');
    const read = await as(owner, 'GET', `/workspaces/${ws}/databases/${issuesDb}/records/${res.json().id}`);
    expect(read.statusCode).toBe(200);
  });

  it('the same event is posted once to a channel even when delivery is asked twice', async () => {
    await subscribe({ database_id: issuesDb, channel: 'eng', events: ['created'] });
    const rec = await createRecord(issuesDb, { name: 'Dedupe me' });
    await settle();
    posted = [];
    const ev: DomainEvent = { type: 'record_created', workspaceId: ws, databaseId: issuesDb, recordId: rec.json().id, actorId: null, depth: 0, eventId: 'dup-1' };
    await svc.onRecordEvent(ev);
    await svc.onRecordEvent(ev);
    await settle();
    expect(posted).toHaveLength(1);
  });
});

describe('deleting the database or the space takes the subscription with it', () => {
  it('a hard delete cascades; a soft-deleted one stops posting (covered above)', async () => {
    const extra = await newDatabase('Cascade', spaceId);
    const sub = await subscribe({ database_id: extra.id, channel: 'eng', events: ['created'] });
    expect(sub.statusCode, sub.body).toBe(201);
    await db.delete(databases).where(eq(databases.id, extra.id));
    expect(await db.query.slackSubscriptions.findFirst({ where: eq(slackSubscriptions.id, sub.json().id) })).toBeUndefined();
  });
});
