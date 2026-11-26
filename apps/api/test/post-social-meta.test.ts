import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { fakeJpeg } from './helpers/jpeg';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, attachments, automationJobs, connections, records, user } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { PostSocialActionService } from '../src/automations/post-social.action';
import { SocialAccountsService } from '../src/connections/social-accounts.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { getStorage } from '../src/attachments/storage';
import { mintAttachmentUrl, signAttachmentUrl } from '../src/attachments/signed-attachment';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #51 — Meta (Facebook Pages + Instagram) publishing, end to end through the real engine, the real Postgres and the
 * real HTTP surface, against a SCRIPTED fake network.
 *
 * NOTHING HERE TOUCHES THE REAL META. Every Graph call goes through a fetcher assigned to the executor's, the picker's and the
 * OAuth exchange's own seams (and under NODE_ENV=test their defaults refuse the network anyway); every token, app id, page and
 * account is a made-up string; nothing is posted anywhere and no Meta app exists.
 *
 * The Meta switch is on for this file only (post-social-meta-gate.test.ts covers it off).
 */
vi.hoisted(() => {
  process.env.META_ACTIONS_ENABLED = 'true';
  process.env.META_APP_ID = 'app-id-not-real';
  process.env.META_APP_SECRET = 'app-secret-not-real';
});

let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let conns: ConnectionsService;
let admin: { token: string; email: string };
let adminId: string;
let member: Person;
let guest: Person;
let outsider: { token: string; email: string };
let wsId: string;
let otherWsId: string;
let spaceId: string;

const SECRET = 'EAAGsecretTOKENvalue123';
const PERSON = 'Maya Chen';
const PAGE = '1001';
const IG = '17841400000000001';
const OTHER_PAGE = '1002';

interface Seen { url: string; method: string; body: string; auth: string }
const graph: Seen[] = [];
type Reply = { status: number; json?: unknown };
let script: (c: Seen) => Reply = () => ({ status: 200, json: { id: '1001_555' } });
const fakeFetch = (async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
  const seen: Seen = { url: String(url), method: init?.method ?? 'GET', body: init?.body instanceof FormData ? '[form]' : String(init?.body ?? ''), auth: init?.headers?.authorization ?? '' };
  graph.push(seen);
  const r = script(seen);
  return { status: r.status, text: async () => '', json: async () => r.json ?? {}, headers: new Headers() };
}) as unknown as typeof fetch;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

const metaAuth = () => ({
  user_token: 'user-token-not-real',
  obtained_at: Date.now(),
  pages: [
    { page_id: PAGE, name: 'Foxglove Florist', page_token: 'page-token-1-not-real', ig_user_id: IG, ig_username: 'foxglove' },
    { page_id: OTHER_PAGE, name: 'Hollow Oak Books', page_token: 'page-token-2-not-real' },
  ],
});

async function connection(provider: 'meta' | 'linkedin' | 'x', workspaceId = wsId, createdBy = adminId) {
  const [row] = await db
    .insert(connections)
    .values({
      workspaceId,
      provider,
      name: `${provider} ${randomUUID().slice(0, 6)}`,
      authSealed: seal(JSON.stringify(provider === 'meta' ? metaAuth() : { access_token: 'fake-token-not-real' })),
      status: 'active',
      createdBy,
    })
    .returning();
  return row!.id;
}

async function scenario() {
  const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Posts ${randomUUID().slice(0, 6)}` })).json().id as string;
  const urlField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Post URL', type: 'url', config: {} })).json() as { id: string };
  const imageField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Image', type: 'attachment', config: {} })).json() as { id: string };
  return { dbId, resultFieldId: urlField.id, imageFieldId: imageField.id, metaConn: await connection('meta') };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const createRule = (s: Scenario, action: Record<string, unknown>) =>
  as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, {
    name: `Meta ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'post_social', text: 'Launch: {Title}', ...action }],
  });
async function record(s: Scenario) {
  const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records`, { values: { name: `Rec ${randomUUID().slice(0, 6)}` } })).json() as { id: string };
  await engine.settle(rec.id);
  return rec.id;
}
async function addImage(s: Scenario, rec: string, bytes: Buffer, mime = 'image/jpeg') {
  const id = randomUUID();
  const key = `${rec}/${id}/original`;
  await getStorage().put(key, bytes, mime);
  await db.insert(attachments).values({ id, recordId: rec, fieldId: s.imageFieldId, filename: 'a.jpg', size: bytes.length, mime, storageKey: key });
  return id;
}
const read = (s: Scenario, rec: string, token = admin.token) => as(token, 'GET', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes`);
const jobFor = async (rec: string) =>
  (await db.query.automationJobs.findMany({ where: eq(automationJobs.workspaceId, wsId) })).filter((j) => (j.payload as { ctx: { recordId: string } }).ctx.recordId === rec);
const graphCalls = (rec?: string) => graph.filter((g) => g.url.startsWith('https://graph.facebook.com/') && (rec ? true : true));

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  conns = app.get(ConnectionsService);
  app.get(PostSocialActionService).fetcher = fakeFetch;
  app.get(PostSocialActionService).metaPoll = { intervalMs: 0, maxAttempts: 3, sleep: async () => undefined };
  app.get(SocialAccountsService).fetcher = (async (url, init) => fakeFetch(url, init as never)) as never;

  admin = await signUpUser(app, 'Meta Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Meta WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  member = await joinAs(app, admin.token, wsId, 'Meta Member', 'member');
  const scratch = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Guest scratch' })).json().id as string;
  guest = await joinAs(app, admin.token, wsId, 'Meta Guest', 'guest', [{ database_id: scratch, role: 'viewer' }]);
  outsider = await signUpUser(app, 'Meta Outsider');
  otherWsId = (await as(outsider.token, 'POST', '/workspaces', { name: 'Other Meta WS' })).json().id;
}, 120_000);

afterAll(async () => {
  delete process.env.META_ACTIONS_ENABLED;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  await app.close();
});

describe('the gallery and the OAuth connect (fake token endpoint and Graph)', () => {
  it('the catalog lists meta as Tier B and connectable once the operator env is present', async () => {
    const list = (await as(admin.token, 'GET', `/workspaces/${wsId}/connections/providers`)).json().data as Array<{ id: string; tier: string; availability: string; oauth?: { configured: boolean; scopes: string[] } }>;
    const meta = list.find((p) => p.id === 'meta')!;
    expect(meta).toMatchObject({ tier: 'oauth_managed', availability: 'connectable' });
    expect(meta.oauth!.configured).toBe(true);
    expect(meta.oauth!.scopes).toContain('pages_manage_posts');
  });

  it('start -> callback: scopes comma-joined, state and nonce enforced, long-lived token + pages sealed, nothing secret returned', async () => {
    const start = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/oauth/meta/start`);
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.origin + authorize.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(authorize.searchParams.get('client_id')).toBe('app-id-not-real');
    expect(authorize.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish');
    expect(String(start.headers.location)).not.toContain('app-secret-not-real');
    const state = authorize.searchParams.get('state')!;
    const cookie = String(([] as string[]).concat(start.headers['set-cookie'] as never)[0]).split(';')[0]!;

    // a forged state and a state from another browser are refused before anything provider-specific
    const forged = await app.inject({ method: 'GET', url: '/api/v1/connections/oauth/callback?state=forged&code=c' });
    expect(forged.statusCode).toBe(400);
    const wrongBrowser = await app.inject({ method: 'GET', url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=c` });
    expect(wrongBrowser.statusCode).toBe(400);

    const seen: Array<{ url: string; body: string; auth?: string }> = [];
    const original = conns.fetcher;
    conns.fetcher = async (url, init) => {
      seen.push({ url, body: String(init.body ?? ''), auth: init.headers?.authorization });
      if (url.endsWith('/oauth/access_token') && String(init.body).includes('authorization_code')) return { status: 200, json: async () => ({ access_token: 'short-not-real' }), text: async () => '' };
      if (url.endsWith('/oauth/access_token')) return { status: 200, json: async () => ({ access_token: 'long-not-real', expires_in: 5184000 }), text: async () => '' };
      return { status: 200, json: async () => ({ data: [{ id: PAGE, name: 'Foxglove Florist', access_token: 'page-secret-not-real', instagram_business_account: { id: IG, username: 'foxglove' } }] }), text: async () => '' };
    };
    try {
      const done = await app.inject({ method: 'GET', url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`, headers: { cookie } });
      expect(done.statusCode).toBe(302);
      expect(String(done.headers.location)).toContain('connected=meta');
    } finally {
      conns.fetcher = original;
    }
    expect(seen.map((c) => c.url.replace(/\?.*/, ''))).toEqual([
      'https://graph.facebook.com/oauth/access_token',
      'https://graph.facebook.com/v21.0/oauth/access_token',
      'https://graph.facebook.com/v21.0/me/accounts',
    ]);
    expect(seen[2]!.auth).toBe('Bearer long-not-real');
    for (const c of seen) expect(c.url).not.toMatch(/secret|not-real/);

    const listed = await as(admin.token, 'GET', `/workspaces/${wsId}/connections`);
    const row = (listed.json().data as Array<{ provider: string; status: string }>).find((c) => c.provider === 'meta' && c.status === 'active')!;
    expect(row).toBeDefined();
    expect(listed.body).not.toMatch(/page-secret|long-not-real|short-not-real|app-secret/);
    // sealed at rest: the stored blob is not the plaintext, and decrypts to the pages with their own tokens
    const stored = (await db.query.connections.findMany({ where: eq(connections.workspaceId, wsId) })).find((c) => c.provider === 'meta' && c.createdBy === adminId && c.authSealed && !c.authSealed.includes('page-secret'))!;
    expect(stored.authSealed).not.toContain('page-secret-not-real');
    expect(stored.scopes).toEqual(['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish']);
    const opened = await conns.getDecryptedAuth(wsId, stored.id);
    expect((opened.auth as { pages: Array<{ page_token: string }> }).pages[0]!.page_token).toBe('page-secret-not-real');
  });
});

describe('the account picker serves a Meta connection', () => {
  const live = { data: [{ id: PAGE, name: 'Foxglove Florist', instagram_business_account: { id: IG, username: 'foxglove' } }, { id: OTHER_PAGE, name: 'Hollow Oak Books' }] };

  it('lists the Pages and the linked Instagram account as {id,name,type,handle?}, with no token', async () => {
    const conn = await connection('meta');
    graph.length = 0;
    script = () => ({ status: 200, json: live });
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([
      { id: PAGE, name: 'Foxglove Florist', type: 'facebook_page' },
      { id: IG, name: '@foxglove', type: 'instagram_business', handle: 'foxglove' },
      { id: OTHER_PAGE, name: 'Hollow Oak Books', type: 'facebook_page' },
    ]);
    expect(res.body).not.toMatch(/token/);
    expect(graph[0]!.auth).toBe('Bearer user-token-not-real');
    expect(graph[0]!.url).not.toMatch(/token/);
  });

  it('a Page no longer granted is a warning, never an option', async () => {
    const conn = await connection('meta');
    script = () => ({ status: 200, json: { data: [live.data[1]] } });
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`);
    expect(res.json().data.map((a: { id: string }) => a.id)).toEqual([OTHER_PAGE]);
    expect(res.json().warnings[0]).toMatchObject({ code: 'pages_unavailable' });
  });

  it('Meta saying the token is dead (190) flips the connection to expired and answers a safe 422', async () => {
    const conn = await connection('meta');
    script = () => ({ status: 400, json: { error: { code: 190, message: `bad ${SECRET}` } } });
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`);
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(SECRET);
    expect((await db.query.connections.findFirst({ where: eq(connections.id, conn) }))!.status).toBe('expired');
  });

  it('another provider error is a 502 with no network text', async () => {
    const conn = await connection('meta');
    script = () => ({ status: 500, json: { error: { code: 2, message: SECRET } } });
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(SECRET);
  });

  it('who may ask: the admin and the connection\'s creator; a member and a guest get 403; another workspace is a 404', async () => {
    const conn = await connection('meta');
    script = () => ({ status: 200, json: live });
    for (const who of [member, guest]) expect((await as(who.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`)).statusCode).toBe(403);
    expect((await as(outsider.token, 'GET', `/workspaces/${otherWsId}/connections/${conn}/social-accounts`)).statusCode, 'the other workspace cannot see it exists').toBe(404);
    expect((await as(outsider.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`)).statusCode).toBeGreaterThanOrEqual(403);
    const creator = await connection('meta', wsId, member.id);
    expect((await as(member.token, 'GET', `/workspaces/${wsId}/connections/${creator}/social-accounts`)).statusCode).toBe(200);
  });
});

describe('saving a Meta post rule', () => {
  it('a valid Facebook Page rule and a valid Instagram rule save', async () => {
    const s = await scenario();
    const fb = await createRule(s, { connection_id: s.metaConn, target: 'facebook_page', account_id: PAGE });
    expect(fb.statusCode, fb.body).toBe(201);
    const ig = await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG, media_field_id: s.imageFieldId });
    expect(ig.statusCode, ig.body).toBe(201);
  });

  it('every way of NOT naming the account is a 422', async () => {
    const s = await scenario();
    for (const target of ['facebook_page', 'instagram_business']) {
      const extra = target === 'instagram_business' ? { media_field_id: s.imageFieldId } : {};
      for (const account_id of [undefined, '', 'abc', '10 01', '../1001', 'urn:li:organization:1']) {
        const res = await createRule(s, { connection_id: s.metaConn, target, ...(account_id === undefined ? {} : { account_id }), ...extra });
        expect(res.statusCode, `${target} / ${String(account_id)}: ${res.body}`).toBe(422);
      }
    }
  });

  it('Instagram without an image field is a 422 at save, not a failed post later', async () => {
    const s = await scenario();
    const res = await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/needs an image/);
  });

  it('a connection of the wrong provider is a 422, either way round', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    const x = await connection('x');
    for (const conn of [li, x]) {
      const res = await createRule(s, { connection_id: conn, target: 'facebook_page', account_id: PAGE });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/must be a 'meta' connection/);
    }
    const reverse = await createRule(s, { connection_id: s.metaConn, target: 'x' });
    expect(reverse.statusCode).toBe(422);
  });

  it('another workspace\'s connection is refused', async () => {
    const s = await scenario();
    const foreign = await connection('meta', otherWsId, adminId);
    const res = await createRule(s, { connection_id: foreign, target: 'facebook_page', account_id: PAGE });
    expect(res.statusCode).toBe(422);
  });
});

describe('publishing through the real engine (fake Graph)', () => {
  it('Facebook Page: approval -> the named page\'s feed with its own token -> URL written back; exactly one call', async () => {
    const s = await scenario();
    const rule = await createRule(s, { connection_id: s.metaConn, target: 'facebook_page', account_id: OTHER_PAGE, result_field_id: s.resultFieldId });
    expect(rule.statusCode, rule.body).toBe(201);
    const rec = await record(s);
    const pending = (await db.query.approvals.findMany({ where: eq(approvals.recordId, rec) })).find((a) => a.status === 'pending')!;
    graph.length = 0;
    script = () => ({ status: 200, json: { id: `${OTHER_PAGE}_777` } });
    expect((await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${pending.id}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();

    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ url: `https://graph.facebook.com/v21.0/${OTHER_PAGE}/feed`, method: 'POST', auth: 'Bearer page-token-2-not-real' });
    const state = ((await read(s, rec)).json().data as any[])[0];
    expect(state).toMatchObject({ channel: 'facebook', target: 'facebook_page', state: 'published', post_url: `https://www.facebook.com/${OTHER_PAGE}_777`, error: null });
    expect(state.account).toMatchObject({ connection_id: s.metaConn, account_id: OTHER_PAGE });
    const row = await db.query.records.findFirst({ where: eq(records.id, rec) });
    expect((row!.values as Record<string, unknown>)[s.resultFieldId]).toBe(`https://www.facebook.com/${OTHER_PAGE}_777`);
    // the job carries the connection id (circuit breaker + rate budget apply)
    expect((await jobFor(rec))[0]!.connectionId).toBe(s.metaConn);
  });

  it('a rule that names a Page the connection does not hold posts NOTHING (account_mismatch), and the read says why', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'facebook_page', account_id: '424242', require_approval: false });
    const rec = await record(s);
    graph.length = 0;
    await jobs.tick();
    expect(graph, 'no call reached Meta').toHaveLength(0);
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item).toMatchObject({ state: 'failed' });
    expect(item.error.code).toBe('account_mismatch');
  });

  it('a job with no named account (crafted: a payload edited by hand) is refused before any call', async () => {
    const s = await scenario();
    const rec = await record(s);
    const [job] = await db
      .insert(automationJobs)
      .values({
        workspaceId: wsId,
        runId: randomUUID(),
        connectionId: s.metaConn,
        actionIndex: 0,
        kind: 'post_social',
        payload: { action: { type: 'post_social', connection_id: s.metaConn, target: 'facebook_page', text: 'hi' }, ctx: { workspaceId: wsId, databaseId: s.dbId, recordId: rec, actorId: adminId } },
        idempotencyKey: `${randomUUID()}:${rec}:run:0`,
        status: 'queued',
        timeoutClass: 'long',
      })
      .returning();
    graph.length = 0;
    await jobs.tick();
    expect(graph).toHaveLength(0);
    const after = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job!.id) });
    expect(after!.status).toBe('failed');
    expect(after!.lastError).toMatch(/^\[no_account\] .*Facebook Page/);
  });

  it('a Meta target run on a LinkedIn connection is refused (wrong_connection), nothing sent', async () => {
    const s = await scenario();
    const rec = await record(s);
    const li = await connection('linkedin');
    const [job] = await db
      .insert(automationJobs)
      .values({
        workspaceId: wsId,
        runId: randomUUID(),
        connectionId: li,
        actionIndex: 0,
        kind: 'post_social',
        payload: { action: { type: 'post_social', connection_id: li, target: 'facebook_page', account_id: PAGE, text: 'hi' }, ctx: { workspaceId: wsId, databaseId: s.dbId, recordId: rec, actorId: adminId } },
        idempotencyKey: `${randomUUID()}:${rec}:run:0`,
        status: 'queued',
        timeoutClass: 'long',
      })
      .returning();
    graph.length = 0;
    await jobs.tick();
    expect(graph).toHaveLength(0);
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job!.id) }))!.lastError).toMatch(/^\[wrong_connection\]/);
  });

  it('Meta saying the token is dead (190) while posting: reconnect_required on the record, the connection flipped to expired, the creator notified', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'facebook_page', account_id: PAGE, require_approval: false });
    const rec = await record(s);
    script = () => ({ status: 400, json: { error: { code: 190, error_subcode: 463, message: `Token ${SECRET} belongs to ${PERSON}` } } });
    await jobs.tick();
    const body = (await read(s, rec)).json();
    expect(body.data[0]).toMatchObject({ state: 'failed' });
    expect(body.data[0].error.code).toBe('reconnect_required');
    for (const leaked of [SECRET, PERSON]) expect(JSON.stringify(body)).not.toContain(leaked);
    expect((await db.query.connections.findFirst({ where: eq(connections.id, s.metaConn) }))!.status).toBe('expired');
    const notifs = await as(admin.token, 'GET', `/workspaces/${wsId}/notifications?type=connection_error`);
    expect(JSON.stringify(notifs.json())).toMatch(/needs reconnecting/);
  });

  it('a retry reuses the ORIGINAL connection and named Page; a body trying to pick another account is a 422', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'facebook_page', account_id: OTHER_PAGE, require_approval: false });
    const rec = await record(s);
    script = () => ({ status: 403, json: { error: { code: 200, message: `no ${PERSON}` } } });
    await jobs.tick();
    const failed = ((await read(s, rec)).json().data as any[])[0];
    expect(failed.error.code).toBe('forbidden');
    expect(failed.can_retry).toBe(true);

    const retryUrl = `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes/${failed.publish_id}/retry`;
    expect((await as(admin.token, 'POST', retryUrl, { account_id: PAGE })).statusCode).toBe(422);
    expect((await as(admin.token, 'POST', retryUrl, { connection_id: randomUUID() })).statusCode).toBe(422);

    graph.length = 0;
    script = () => ({ status: 200, json: { id: `${OTHER_PAGE}_900` } });
    expect((await as(admin.token, 'POST', retryUrl, {})).statusCode).toBe(202);
    await jobs.tick();
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ url: `https://graph.facebook.com/v21.0/${OTHER_PAGE}/feed`, auth: 'Bearer page-token-2-not-real' });
    expect(((await read(s, rec)).json().data as any[])[0]).toMatchObject({ state: 'published', post_url: `https://www.facebook.com/${OTHER_PAGE}_900` });
  });

  it('Instagram: the image reaches Meta by a short-lived signed URL that serves exactly that image, then expires; nothing is public', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG, media_field_id: s.imageFieldId, result_field_id: s.resultFieldId, require_approval: false });
    const rec = await record(s);
    const bytes = fakeJpeg(1080, 1350);
    const attachmentId = await addImage(s, rec, bytes);
    graph.length = 0;
    script = (c) => {
      if (c.url.endsWith(`/${IG}/media`)) return { status: 200, json: { id: '9001' } };
      if (c.url.includes('/9001?fields=status_code')) return { status: 200, json: { status_code: 'FINISHED' } };
      if (c.url.endsWith(`/${IG}/media_publish`)) return { status: 200, json: { id: '9002' } };
      return { status: 200, json: { permalink: 'https://www.instagram.com/p/XYZ/' } };
    };
    await jobs.tick();

    expect(graph.map((g) => g.url.replace('https://graph.facebook.com/v21.0', ''))).toEqual([`/${IG}/media`, '/9001?fields=status_code', `/${IG}/media_publish`, '/9002?fields=permalink']);
    for (const g of graph) expect(g.auth).toBe('Bearer page-token-1-not-real');
    const imageUrl = new URL(new URLSearchParams(graph[0]!.body).get('image_url')!);
    expect(imageUrl.pathname).toBe(`/api/v1/attachments/signed/${attachmentId}`);

    // Meta fetches it with no session: it serves the image, never cached
    const fetched = await app.inject({ method: 'GET', url: imageUrl.pathname + imageUrl.search });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/jpeg');
    expect(fetched.headers['cache-control']).toBe('private, no-store');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(fetched.rawPayload, bytes)).toBe(0);
    expect(((await read(s, rec)).json().data as any[])[0]).toMatchObject({ channel: 'instagram', state: 'published', post_url: 'https://www.instagram.com/p/XYZ/' });
  });

  it('Instagram constraint violations fail with the specific reason BEFORE anything is sent', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG, media_field_id: s.imageFieldId, require_approval: false });
    const rec = await record(s);
    await addImage(s, rec, fakeJpeg(2000, 500));
    graph.length = 0;
    await jobs.tick();
    expect(graph, 'nothing was created on Meta\'s side').toHaveLength(0);
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item.error.code).toBe('media_unsupported');
    expect(item.error.message).toMatch(/2000 by 500/);
    expect(item.can_retry, 'the same image fails the same way, but a person may fix the image and retry').toBe(true);
  });

  it('Instagram with no image on the record fails media_required, nothing sent', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG, media_field_id: s.imageFieldId, require_approval: false });
    const rec = await record(s);
    graph.length = 0;
    await jobs.tick();
    expect(graph).toHaveLength(0);
    expect((((await read(s, rec)).json().data as any[])[0]).error.code).toBe('media_required');
  });

  it('an Instagram container that ends in ERROR never reaches media_publish', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.metaConn, target: 'instagram_business', account_id: IG, media_field_id: s.imageFieldId, require_approval: false });
    const rec = await record(s);
    await addImage(s, rec, fakeJpeg(1080, 1080));
    graph.length = 0;
    script = (c) => (c.url.endsWith(`/${IG}/media`) ? { status: 200, json: { id: '9001' } } : { status: 200, json: { status_code: 'ERROR', status: SECRET } });
    await jobs.tick();
    expect(graph.some((g) => g.url.includes('media_publish'))).toBe(false);
    const body = (await read(s, rec)).json();
    expect(body.data[0].error).toMatchObject({ code: 'rejected' });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

describe('the signed attachment URL', () => {
  async function fixture() {
    const s = await scenario();
    const rec = await record(s);
    const bytes = fakeJpeg(1080, 1080);
    const id = await addImage(s, rec, bytes);
    return { s, rec, id, bytes };
  }
  const path = (u: string) => {
    const url = new URL(u);
    return url.pathname + url.search;
  };

  it('a freshly minted URL serves the image; the same id with a different signature, no signature or garbage is 401', async () => {
    const { id, bytes } = await fixture();
    const ok = await app.inject({ method: 'GET', url: path(mintAttachmentUrl(id).url) });
    expect(ok.statusCode).toBe(200);
    expect(Buffer.compare(ok.rawPayload, bytes)).toBe(0);
    const expires = String(Math.floor(Date.now() / 1000) + 600);
    for (const query of ['', `?expires=${expires}`, `?expires=${expires}&sig=deadbeef`, `?expires=${expires}&sig=${'0'.repeat(64)}`, `?sig=${signAttachmentUrl(id, expires)}`]) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/${id}${query}` })).statusCode, query).toBe(401);
    }
  });

  it('a signature minted for one attachment does not open another', async () => {
    const a = await fixture();
    const b = await fixture();
    const expires = String(Math.floor(Date.now() / 1000) + 600);
    const res = await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/${b.id}?expires=${expires}&sig=${signAttachmentUrl(a.id, expires)}` });
    expect(res.statusCode).toBe(401);
  });

  it('an extended expiry does not verify (the expiry is part of what is signed), and a correctly signed expired URL is 410', async () => {
    const { id } = await fixture();
    const past = String(Math.floor(Date.now() / 1000) - 5);
    const sig = signAttachmentUrl(id, past);
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/${id}?expires=${past}&sig=${sig}` })).statusCode).toBe(410);
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/${id}?expires=${future}&sig=${sig}` })).statusCode).toBe(401);
    // the 15 minute TTL
    const minted = new URL(mintAttachmentUrl(id, Date.now()).url);
    const ttl = Number(minted.searchParams.get('expires')) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(14 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60 + 1);
  });

  it('once the record is trashed the URL answers 404, valid signature or not', async () => {
    const { id, rec, s } = await fixture();
    const url = path(mintAttachmentUrl(id).url);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('a non-UUID id is rejected and an unknown attachment is a 404', async () => {
    const future = String(Math.floor(Date.now() / 1000) + 600);
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/not-a-uuid?expires=${future}&sig=x` })).statusCode).toBeGreaterThanOrEqual(400);
    const ghost = randomUUID();
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/signed/${ghost}?expires=${future}&sig=${signAttachmentUrl(ghost, future)}` })).statusCode).toBe(404);
  });
});
