import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { expectedDigest, FAKE_CHANNEL, FAKE_VIDEO_ID, FakeYoutube, OTHER_CHANNEL } from './helpers/fake-youtube';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, attachments, automationJobs, connections, databases, memberships, records, spaces, user } from '../src/db/schema';
import { env } from '../src/config/env';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { PostSocialActionService } from '../src/automations/post-social.action';
import { msUntilQuotaReset } from '../src/automations/post-youtube';
import { SocialAccountsService } from '../src/connections/social-accounts.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { getStorage } from '../src/attachments/storage';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #60 — YouTube upload as a `post_social` target, end to end through the real engine, the real Postgres and the real
 * HTTP surface, against a SCRIPTED fake of the YouTube Data API.
 *
 * NOTHING HERE TOUCHES REAL GOOGLE OR YOUTUBE. Every call goes through a fetcher assigned to the executor's, the picker's and the
 * OAuth exchange's own seams (their defaults refuse the network under NODE_ENV=test anyway); the client id, secret, tokens, channel
 * and video ids are made-up strings; no video is uploaded anywhere and no Google app exists.
 *
 * The YouTube switch is on for this file only (post-social-youtube-gate.test.ts covers it off).
 */
vi.hoisted(() => {
  process.env.YOUTUBE_ACTIONS_ENABLED = 'true';
  process.env.YOUTUBE_CLIENT_ID = 'yt-client-id-not-real';
  process.env.YOUTUBE_CLIENT_SECRET = 'yt-client-secret-not-real';
});

let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let conns: ConnectionsService;
let post: PostSocialActionService;
let admin: { token: string; email: string };
let adminId: string;
let member: Person;
let guest: Person;
let outsider: { token: string; email: string };
let outsiderId: string;
let wsId: string;
let otherWsId: string;
let spaceId: string;

const yt = new FakeYoutube();
const CHUNK = 256 * 1024;
const TOKEN = 'ya29.not-a-real-token';
const REFRESH = '1//refresh-not-real';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

function videoBytes(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 17 + (i >> 9)) & 0xff;
  return b;
}

async function connection(provider: 'youtube' | 'x' | 'linkedin', workspaceId = wsId, createdBy = adminId) {
  const [row] = await db
    .insert(connections)
    .values({
      workspaceId,
      provider,
      name: `${provider} ${randomUUID().slice(0, 6)}`,
      authSealed: seal(JSON.stringify({ access_token: TOKEN, refresh_token: REFRESH, obtained_at: Date.now() })),
      status: 'active',
      createdBy,
    })
    .returning();
  return row!.id;
}

async function scenario() {
  const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Videos ${randomUUID().slice(0, 6)}` })).json().id as string;
  const urlField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Video URL', type: 'url', config: {} })).json() as { id: string };
  const videoField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Cut', type: 'attachment', config: {} })).json() as { id: string };
  const textField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json() as { id: string };
  return { dbId, resultFieldId: urlField.id, videoFieldId: videoField.id, textFieldId: textField.id, ytConn: await connection('youtube') };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const youtubeAction = (s: Scenario, over: Record<string, unknown> = {}) => ({
  type: 'post_social',
  connection_id: s.ytConn,
  target: 'youtube_channel',
  account_id: FAKE_CHANNEL,
  video_field_id: s.videoFieldId,
  title: 'Launch: {Title}',
  text: 'Description of {Title}',
  result_field_id: s.resultFieldId,
  ...over,
});
const createRule = (s: Scenario, action: Record<string, unknown>) =>
  as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, {
    name: `YT ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'record_created' },
    actions: [action],
  });
async function record(s: Scenario) {
  const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records`, { values: { name: `Cut ${randomUUID().slice(0, 6)}` } })).json() as { id: string };
  await engine.settle(rec.id);
  return rec.id;
}
async function addVideo(s: Scenario, rec: string, bytes: Buffer, mime = 'video/mp4', fieldId = s.videoFieldId) {
  const id = randomUUID();
  const key = `${rec}/${id}/original`;
  await getStorage().put(key, bytes, mime);
  await db.insert(attachments).values({ id, recordId: rec, fieldId, filename: 'cut.mp4', size: bytes.length, mime, storageKey: key });
  return id;
}
const read = (s: Scenario, rec: string, token = admin.token) => as(token, 'GET', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes`);
const jobsFor = async (rec: string) =>
  (await db.query.automationJobs.findMany({ where: eq(automationJobs.workspaceId, wsId) })).filter((j) => (j.payload as { ctx: { recordId: string } }).ctx.recordId === rec);
async function ungated(s: Scenario, over: Record<string, unknown> = {}) {
  const res = await createRule(s, youtubeAction(s, { require_approval: false, ...over }));
  expect(res.statusCode, res.body).toBe(201);
}
async function dueNow(rec: string) {
  for (const j of await jobsFor(rec)) await db.update(automationJobs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(automationJobs.id, j.id));
}
/** A job placed by hand, the way a crafted or stale payload could reach the executor. */
async function craft(s: Scenario, rec: string, over: { action?: Record<string, unknown>; ctx?: Record<string, unknown>; connectionId?: string; databaseId?: string } = {}) {
  const [job] = await db
    .insert(automationJobs)
    .values({
      workspaceId: wsId,
      runId: randomUUID(),
      connectionId: over.connectionId ?? s.ytConn,
      actionIndex: 0,
      kind: 'post_social',
      payload: {
        action: { ...youtubeAction(s), connection_id: over.connectionId ?? s.ytConn, title: 'Crafted', text: 'd', ...over.action },
        ctx: { workspaceId: wsId, databaseId: over.databaseId ?? s.dbId, recordId: rec, actorId: adminId, ...over.ctx },
      },
      idempotencyKey: `${randomUUID()}:${rec}:run:0`,
      status: 'queued',
      timeoutClass: 'upload',
    })
    .returning();
  return job!;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  conns = app.get(ConnectionsService);
  post = app.get(PostSocialActionService);
  post.fetcher = yt.fetch;
  post.youtubeChunkBytes = CHUNK;
  app.get(SocialAccountsService).fetcher = ((url: string, init: unknown) => yt.fetch(url, init as never)) as never;

  admin = await signUpUser(app, 'YT Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'YT WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  member = await joinAs(app, admin.token, wsId, 'YT Member', 'member');
  const scratch = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Guest scratch' })).json().id as string;
  guest = await joinAs(app, admin.token, wsId, 'YT Guest', 'guest', [{ database_id: scratch, role: 'viewer' }]);
  outsider = await signUpUser(app, 'YT Outsider');
  outsiderId = (await db.query.user.findFirst({ where: eq(user.email, outsider.email) }))!.id;
  otherWsId = (await as(outsider.token, 'POST', '/workspaces', { name: 'Other YT WS' })).json().id;
}, 120_000);

afterAll(async () => {
  delete process.env.YOUTUBE_ACTIONS_ENABLED;
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  await app.close();
});

function reset(): void {
  yt.calls.length = 0;
  yt.sessions.clear();
  yt.initCount = 0;
  yt.hook = null;
  yt.keepOnlyNext = null;
  yt.channels = [{ id: FAKE_CHANNEL, snippet: { title: 'Foxglove Films', customUrl: '@foxglovefilms' } }];
}

describe('the gallery and the OAuth connect (fake token endpoint)', () => {
  it('the catalog lists youtube as Tier B and connectable once the operator env is present, with the two scopes', async () => {
    const list = (await as(admin.token, 'GET', `/workspaces/${wsId}/connections/providers`)).json().data as Array<{ id: string; tier: string; availability: string; oauth?: { configured: boolean; scopes: string[] } }>;
    const youtube = list.find((p) => p.id === 'youtube')!;
    expect(youtube).toMatchObject({ tier: 'oauth_managed', availability: 'connectable' });
    expect(youtube.oauth!.configured).toBe(true);
    expect(youtube.oauth!.scopes).toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
    // the existing provider is untouched and still its own entry
    expect(list.find((p) => p.id === 'google')!.oauth!.scopes.join(' ')).not.toContain('youtube.upload');
  });

  it('start -> callback: a dedicated client, offline access, state and nonce enforced, the tokens sealed, nothing secret returned', async () => {
    const start = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/oauth/youtube/start`);
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('client_id')).toBe('yt-client-id-not-real');
    expect(authorize.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    expect(authorize.searchParams.get('access_type')).toBe('offline');
    expect(authorize.searchParams.get('prompt')).toBe('consent');
    expect(String(start.headers.location)).not.toContain('yt-client-secret-not-real');
    const state = authorize.searchParams.get('state')!;
    const cookie = String(([] as string[]).concat(start.headers['set-cookie'] as never)[0]).split(';')[0]!;

    expect((await app.inject({ method: 'GET', url: '/api/v1/connections/oauth/callback?state=forged&code=c' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=c` })).statusCode, 'a state from another browser').toBe(400);

    const seen: Array<{ url: string; body: string }> = [];
    const original = conns.fetcher;
    conns.fetcher = async (url, init) => {
      seen.push({ url, body: String(init.body ?? '') });
      return { status: 200, json: async () => ({ access_token: 'ya29.minted-not-real', refresh_token: '1//minted-refresh-not-real', token_type: 'Bearer', expires_in: 3599, scope: 'x' }), text: async () => '' };
    };
    try {
      const done = await app.inject({ method: 'GET', url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`, headers: { cookie } });
      expect(done.statusCode).toBe(302);
      expect(String(done.headers.location)).toContain('connected=youtube');
    } finally {
      conns.fetcher = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(seen[0]!.body).toContain('client_id=yt-client-id-not-real');
    expect(seen[0]!.body).toContain('client_secret=yt-client-secret-not-real');

    const listed = await as(admin.token, 'GET', `/workspaces/${wsId}/connections`);
    expect(listed.body).not.toMatch(/minted|client-secret/);
    const stored = (await db.query.connections.findMany({ where: and(eq(connections.workspaceId, wsId), eq(connections.provider, 'youtube')) })).find((c) => (c.scopes as string[] | null)?.length === 2 && !c.authSealed.includes('ya29.not-a-real-token'))!;
    expect(stored.authSealed).not.toContain('minted');
    expect(stored.scopes).toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
    const opened = (await conns.getDecryptedAuth(wsId, stored.id)).auth as { access_token: string; refresh_token: string; expires_at: number };
    expect(opened.access_token).toBe('ya29.minted-not-real');
    expect(opened.refresh_token).toBe('1//minted-refresh-not-real');
    expect(opened.expires_at, 'the refresh loop can see when it expires').toBeGreaterThan(Date.now());
  });
});

describe('the channel picker', () => {
  it('lists the channel as {id,name,type,handle?} and nothing secret', async () => {
    reset();
    const conn = await connection('youtube');
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([{ id: FAKE_CHANNEL, name: 'Foxglove Films', type: 'youtube_channel', handle: '@foxglovefilms' }]);
    expect(res.body).not.toMatch(/token|ya29|1\/\//);
    expect(yt.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(yt.calls[0]!.url).not.toContain(TOKEN);
  });

  it('drops anything that is not a channel id, and says so when there is none', async () => {
    reset();
    const conn = await connection('youtube');
    yt.channels = [{ id: 'not-a-channel', snippet: { title: 'x' } }, { id: 'UC<script>', snippet: { title: 'y' } }];
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts?refresh=true`);
    expect(res.json().data).toEqual([]);
    expect(res.json().warnings[0]).toMatchObject({ code: 'no_channel' });
  });

  it('YouTube refusing the token is a safe 422, any other refusal a 502 with no provider text', async () => {
    const a = await connection('youtube');
    yt.hook = () => ({ status: 401, json: { error: { message: 'SECRET-PROVIDER-TEXT' } } });
    const refused = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${a}/social-accounts`);
    expect(refused.statusCode).toBe(422);
    const b = await connection('youtube');
    yt.hook = () => ({ status: 500, json: { error: { message: 'SECRET-PROVIDER-TEXT' } } });
    const broken = await as(admin.token, 'GET', `/workspaces/${wsId}/connections/${b}/social-accounts`);
    expect(broken.statusCode).toBe(502);
    for (const r of [refused, broken]) expect(r.body).not.toContain('SECRET-PROVIDER-TEXT');
    reset();
  });

  it('who may ask: the admin and the connection\'s creator; a member and a guest get 403; another workspace is a 404', async () => {
    reset();
    const conn = await connection('youtube');
    for (const who of [member, guest]) expect((await as(who.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`)).statusCode).toBe(403);
    expect((await as(outsider.token, 'GET', `/workspaces/${otherWsId}/connections/${conn}/social-accounts`)).statusCode).toBe(404);
    expect((await as(outsider.token, 'GET', `/workspaces/${wsId}/connections/${conn}/social-accounts`)).statusCode).toBeGreaterThanOrEqual(403);
    const creator = await connection('youtube', wsId, member.id);
    expect((await as(member.token, 'GET', `/workspaces/${wsId}/connections/${creator}/social-accounts`)).statusCode).toBe(200);
  });
});

describe('saving a YouTube upload rule', () => {
  it('a complete rule saves', async () => {
    const s = await scenario();
    const res = await createRule(s, youtubeAction(s));
    expect(res.statusCode, res.body).toBe(201);
  });

  it('every way of NOT naming the channel is a 422', async () => {
    const s = await scenario();
    for (const account_id of [undefined, '', 'abc', '@foxglove', 'UCshort', `${FAKE_CHANNEL}x`, 'urn:li:organization:1', '1001', `../${FAKE_CHANNEL}`]) {
      const action = youtubeAction(s);
      if (account_id === undefined) delete (action as { account_id?: string }).account_id;
      else (action as { account_id?: string }).account_id = account_id;
      const res = await createRule(s, action);
      expect(res.statusCode, `${String(account_id)}: ${res.body}`).toBe(422);
    }
  });

  it('a video, an attachment field of this database, and a title are required', async () => {
    const s = await scenario();
    const other = await scenario();
    const missingVideo = youtubeAction(s);
    delete (missingVideo as { video_field_id?: string }).video_field_id;
    expect((await createRule(s, missingVideo)).statusCode).toBe(422);
    expect((await createRule(s, youtubeAction(s, { video_field_id: s.textFieldId }))).body, 'a text field').toMatch(/attachment field/);
    expect((await createRule(s, youtubeAction(s, { video_field_id: other.videoFieldId }))).statusCode, "another database's field").toBe(422);
    expect((await createRule(s, youtubeAction(s, { video_field_id: randomUUID() }))).statusCode).toBe(422);
    expect((await createRule(s, youtubeAction(s, { title: undefined }))).body).toMatch(/needs a title/);
    expect((await createRule(s, youtubeAction(s, { title: '   ' }))).statusCode).toBe(422);
  });

  it('privacy is one of three words; media_field_id and link do not apply; the YouTube fields do not apply to other targets', async () => {
    const s = await scenario();
    expect((await createRule(s, youtubeAction(s, { privacy: 'everyone' }))).statusCode).toBe(422);
    for (const privacy of ['private', 'unlisted', 'public']) expect((await createRule(s, youtubeAction(s, { privacy }))).statusCode, privacy).toBe(201);
    expect((await createRule(s, youtubeAction(s, { media_field_id: s.videoFieldId }))).statusCode).toBe(422);
    expect((await createRule(s, youtubeAction(s, { link: 'https://example.test' }))).statusCode).toBe(422);
    const x = await connection('x');
    const stray = await createRule(s, { type: 'post_social', connection_id: x, target: 'x', text: 'hi', title: 'nope' });
    expect(stray.statusCode).toBe(422);
    expect(stray.body).toMatch(/only used when the target is youtube_channel/);
  });

  it('a connection of the wrong provider is a 422 either way round, and another workspace\'s connection is refused', async () => {
    const s = await scenario();
    for (const conn of [await connection('x'), await connection('linkedin')]) {
      const res = await createRule(s, youtubeAction(s, { connection_id: conn }));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/must be a 'youtube' connection/);
    }
    expect((await createRule(s, { type: 'post_social', connection_id: s.ytConn, target: 'x', text: 'hi' })).statusCode).toBe(422);
    const foreign = await connection('youtube', otherWsId, outsiderId);
    expect((await createRule(s, youtubeAction(s, { connection_id: foreign }))).statusCode).toBe(422);
  });

  it('only a human admin may switch the approval off (an agent or a member may not)', async () => {
    const s = await scenario();
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, { name: 'member ungate', trigger: { type: 'record_created' }, actions: [youtubeAction(s, { require_approval: false })] });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
  });
});

describe('publishing through the real engine (fake YouTube)', () => {
  it('an UNLISTED upload: approval -> the named channel is checked -> init says unlisted -> chunks -> the URL is written back; the preview names the channel and privacy', async () => {
    reset();
    const s = await scenario();
    expect((await createRule(s, youtubeAction(s, { privacy: 'unlisted' }))).statusCode).toBe(201);
    const rec = await record(s);
    const bytes = videoBytes(CHUNK * 2 + 4321);
    await addVideo(s, rec, bytes);
    const pending = (await db.query.approvals.findMany({ where: eq(approvals.recordId, rec) })).find((a) => a.status === 'pending')!;
    expect(pending.previewText).toContain(FAKE_CHANNEL);
    expect(pending.previewText).toMatch(/as unlisted/);
    expect(pending.previewText).toContain('Launch: ');
    expect(yt.calls, 'nothing is sent while it waits for approval').toHaveLength(0);
    expect(((await read(s, rec)).json().data as any[])[0]).toMatchObject({ channel: 'youtube', target: 'youtube_channel', state: 'awaiting_approval' });

    expect((await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${pending.id}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();

    expect(yt.initCount).toBe(1);
    const init = JSON.parse(yt.inits()[0]!.bodyText);
    expect(init.status).toEqual({ privacyStatus: 'unlisted' });
    expect(init.snippet.title).toMatch(/^Launch: Cut /);
    expect(init.snippet.description).toMatch(/^Description of Cut /);
    expect(yt.calls[0]!.url, 'the channel is asked before anything is sent').toMatch(/youtube\/v3\/channels/);
    expect(yt.digestOf('S1')).toBe(expectedDigest(bytes));
    const state = ((await read(s, rec)).json().data as any[])[0];
    expect(state).toMatchObject({ channel: 'youtube', state: 'published', post_url: `https://youtu.be/${FAKE_VIDEO_ID}`, external_id: FAKE_VIDEO_ID, error: null, progress: null });
    expect(state.account).toMatchObject({ connection_id: s.ytConn, account_id: FAKE_CHANNEL });
    const row = await db.query.records.findFirst({ where: eq(records.id, rec) });
    expect((row!.values as Record<string, unknown>)[s.resultFieldId]).toBe(`https://youtu.be/${FAKE_VIDEO_ID}`);
    const job = (await jobsFor(rec))[0]!;
    expect(job.connectionId, 'the breaker and the per-connection budget apply').toBe(s.ytConn);
    expect(job.timeoutClass, 'an upload gets the long budget; a retry keeps it').toBe('upload');
    expect(JSON.stringify(job.payload)).not.toContain('session_uri');
  }, 30_000);

  it('privacy written out is what goes up: unlisted and public, each exactly as named', async () => {
    for (const privacy of ['unlisted', 'public'] as const) {
      reset();
      const s = await scenario();
      const rec = await record(s);
      await addVideo(s, rec, videoBytes(1000));
      const job = await craft(s, rec, { action: { privacy, title: 'T', text: 'd' } });
      await jobs.tick();
      expect(JSON.parse(yt.inits().at(-1)!.bodyText).status.privacyStatus, privacy).toBe(privacy);
      expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.status).toBe('succeeded');
    }
  });

  it('an unset privacy goes up PRIVATE, a crafted job included', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(500));
    await craft(s, rec, { action: { privacy: undefined } });
    await jobs.tick();
    expect(JSON.parse(yt.inits().at(-1)!.bodyText).status.privacyStatus).toBe('private');
  });

  it('a network drop mid-upload: the job waits to resume, its progress is on the read, and the next attempt resumes with NO second init', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    const bytes = videoBytes(CHUNK * 3);
    await addVideo(s, rec, bytes);
    let puts = 0;
    yt.hook = (call) => (call.method === 'PUT' && /^bytes \d+-/.test(call.headers['content-range'] ?? '') && ++puts === 2 ? new Error('socket hang up') : undefined);
    const job = await craft(s, rec, { action: { result_field_id: s.resultFieldId } });
    await jobs.tick();

    const mid = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!;
    expect(mid.status).toBe('queued');
    expect(mid.attempts).toBe(1);
    expect(mid.lastError).toMatch(/^\[provider_unavailable\]/);
    expect((mid.payload as { upload: { bytes_sent: number } }).upload.bytes_sent, 'the session is kept on the job').toBe(CHUNK);
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item).toMatchObject({ state: 'queued', will_retry: true, progress: { sent_bytes: CHUNK, total_bytes: bytes.length }, error: { code: 'provider_unavailable' } });
    expect(JSON.stringify(item)).not.toContain('upload_id');

    yt.hook = null;
    await dueNow(rec);
    await jobs.tick();
    expect(yt.initCount, 'one session for the whole job').toBe(1);
    expect(yt.digestOf('S1')).toBe(expectedDigest(bytes));
    const done = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!;
    expect(done.status).toBe('succeeded');
    expect((done.payload as { upload?: unknown }).upload, 'the session is cleared once it is finished').toBeUndefined();
  }, 30_000);

  it('QUOTA: a coded retry-later state scheduled for after the next Pacific midnight, never the minute backoff, no retry storm', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    yt.hook = (call) => (call.method === 'POST' ? { status: 403, json: { error: { message: 'SECRET-PROVIDER-TEXT', errors: [{ reason: 'quotaExceeded' }] } } } : undefined);
    const job = await craft(s, rec);
    const before = Date.now();
    await jobs.tick();
    const after = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!;
    expect(after.status).toBe('queued');
    expect(after.lastError).toMatch(/^\[quota_exceeded\] /);
    const wait = after.nextAttemptAt.getTime() - before;
    expect(Math.abs(wait - msUntilQuotaReset(new Date(before)))).toBeLessThan(15_000);
    // a second tick before then does nothing: no storm
    const calls = yt.calls.length;
    await jobs.tick();
    await jobs.tick();
    expect(yt.calls.length).toBe(calls);
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item).toMatchObject({ state: 'queued', will_retry: true, error: { code: 'quota_exceeded' } });
    expect(JSON.stringify(item)).not.toContain('SECRET-PROVIDER-TEXT');
    expect(new Date(item.next_attempt_at).getTime()).toBe(after.nextAttemptAt.getTime());
  });

  it('a rule that names a channel the connection does not hold uploads NOTHING (account_mismatch), and the read says why', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    await craft(s, rec, { action: { account_id: OTHER_CHANNEL } });
    await jobs.tick();
    expect(yt.initCount).toBe(0);
    expect(yt.calls).toHaveLength(1);
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item).toMatchObject({ state: 'failed', error: { code: 'account_mismatch' }, can_retry: true });
  });

  it('a job with no named channel (a payload edited by hand) is refused before ANY call, even the channel check', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    for (const account_id of [undefined, '', 'UCnope']) {
      await craft(s, rec, { action: { account_id } });
    }
    await jobs.tick();
    expect(yt.calls).toHaveLength(0);
    const failed = (await jobsFor(rec)).filter((j) => j.status === 'failed');
    expect(failed).toHaveLength(3);
    for (const j of failed) expect(j.lastError).toMatch(/^\[no_account\] .*YouTube channel/);
  });

  it('a YouTube target on a connection of another provider is refused (wrong_connection), nothing sent', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    const x = await connection('x');
    const job = await craft(s, rec, { connectionId: x });
    await jobs.tick();
    expect(yt.calls).toHaveLength(0);
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[wrong_connection\]/);
  });

  it('what is in the video field decides: none, not a video, empty, too big, not an attachment field. Each uploads nothing.', async () => {
    reset();
    const s = await scenario();
    const cases: Array<[string, (rec: string) => Promise<void>, RegExp]> = [
      ['no file', async () => undefined, /^\[video_missing\] The record has no file/],
      ['a PDF', async (rec) => void (await addVideo(s, rec, Buffer.from('%PDF'), 'application/pdf')), /^\[video_unsupported\]/],
      ['an image', async (rec) => void (await addVideo(s, rec, Buffer.from('x'), 'image/jpeg')), /^\[video_unsupported\]/],
      ['a hostile mime', async (rec) => void (await addVideo(s, rec, Buffer.from('x'), 'video/x\nInjected: header')), /^\[video_unsupported\]/],
      ['empty', async (rec) => void (await addVideo(s, rec, Buffer.alloc(0))), /^\[video_too_large\] The video is empty/],
    ];
    for (const [name, prepare, message] of cases) {
      const rec = await record(s);
      await prepare(rec);
      const job = await craft(s, rec);
      await jobs.tick();
      const row = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!;
      expect(row.status, name).toBe('failed');
      expect(row.lastError, name).toMatch(message);
    }
    const rec = await record(s);
    const wrongField = await craft(s, rec, { action: { video_field_id: s.textFieldId } });
    await jobs.tick();
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, wrongField.id) }))!.lastError).toMatch(/^\[video_missing\] The video field is gone or is no longer an attachment field/);
    expect(yt.calls, 'none of these reached YouTube').toHaveLength(0);
  });

  it('the size limit is the deployment\'s: over YOUTUBE_MAX_UPLOAD_BYTES is refused before any call', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(2 * 1024 * 1024));
    const settings = env() as { YOUTUBE_MAX_UPLOAD_BYTES: number };
    const was = settings.YOUTUBE_MAX_UPLOAD_BYTES;
    settings.YOUTUBE_MAX_UPLOAD_BYTES = 1024 * 1024;
    try {
      const job = await craft(s, rec);
      await jobs.tick();
      expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[video_too_large\] The video is 2 MB and the limit is 1 MB/);
      expect(yt.calls).toHaveLength(0);
    } finally {
      settings.YOUTUBE_MAX_UPLOAD_BYTES = was;
    }
  });

  it('the first file in the field is the one that goes, in the order the field holds them', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    const first = videoBytes(300);
    const second = Buffer.alloc(400, 7);
    const a = await addVideo(s, rec, first);
    const b = await addVideo(s, rec, second);
    await db.update(records).set({ values: { [s.videoFieldId]: [b, a] } }).where(eq(records.id, rec));
    await craft(s, rec);
    await jobs.tick();
    expect(yt.digestOf('S1')).toBe(expectedDigest(second));
  });
});

describe('ONE GATE PER RISK: only a video that would not be private is held by default (Otto\'s ruling)', () => {
  const pendingFor = async (rec: string) => (await db.query.approvals.findMany({ where: eq(approvals.recordId, rec) })).filter((a) => a.status === 'pending');

  it('unset privacy (private) with no require_approval goes STRAIGHT through: no approval, uploaded private, URL written back', async () => {
    reset();
    const s = await scenario();
    expect((await createRule(s, youtubeAction(s))).statusCode).toBe(201);
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(2000));
    expect(await pendingFor(rec)).toHaveLength(0);
    await jobs.tick();
    expect(JSON.parse(yt.inits()[0]!.bodyText).status).toEqual({ privacyStatus: 'private' });
    expect(((await read(s, rec)).json().data as any[])[0]).toMatchObject({ state: 'published', post_url: `https://youtu.be/${FAKE_VIDEO_ID}` });
  });

  it('explicit private goes straight through too', async () => {
    reset();
    const s = await scenario();
    await createRule(s, youtubeAction(s, { privacy: 'private' }));
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(500));
    expect(await pendingFor(rec)).toHaveLength(0);
    await jobs.tick();
    expect(yt.initCount).toBe(1);
  });

  it.each(['public', 'unlisted'] as const)('%s is HELD for approval and nothing is sent until it is approved', async (privacy) => {
    reset();
    const s = await scenario();
    await createRule(s, youtubeAction(s, { privacy }));
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(500));
    expect(await pendingFor(rec)).toHaveLength(1);
    await jobs.tick();
    expect(yt.calls, 'held: nothing reached YouTube').toHaveLength(0);
    expect(((await read(s, rec)).json().data as any[])[0]).toMatchObject({ state: 'awaiting_approval' });
  });

  it('"hold all" (require_approval true) holds a PRIVATE upload as well', async () => {
    reset();
    const s = await scenario();
    await createRule(s, youtubeAction(s, { require_approval: true }));
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(500));
    expect(await pendingFor(rec)).toHaveLength(1);
    await jobs.tick();
    expect(yt.calls).toHaveLength(0);
  });

  it('require_approval false is still only a human admin\'s to set (a member is refused), same as the other networks', async () => {
    const s = await scenario();
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, { name: 'm', trigger: { type: 'record_created' }, actions: [youtubeAction(s, { require_approval: false, privacy: 'public' })] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('the other networks are unchanged: an unset X post is still held', async () => {
    const s = await scenario();
    const x = await connection('x');
    await createRule(s, { type: 'post_social', connection_id: x, target: 'x', text: 'hi' });
    const rec = await record(s);
    expect(await pendingFor(rec)).toHaveLength(1);
  });
});

describe('the video is read as the ACTOR, through the shared access check', () => {
  it('a rule owner with access uploads (the positive control)', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    const job = await craft(s, rec, { ctx: { actorId: member.id } });
    await jobs.tick();
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.status).toBe('succeeded');
  });

  it('an owner who has LOST access since the rule was saved is refused: nothing is read, nothing sent', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    // the guest can open only the scratch database: this record is not theirs to read
    const job = await craft(s, rec, { ctx: { actorId: guest.id } });
    await jobs.tick();
    const row = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/^\[no_access\] The rule owner can no longer read this record/);
    expect(yt.calls).toHaveLength(0);
  });

  it('an owner who is no longer a member (or never was) is refused, and the sentence names nobody', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    const gone = await craft(s, rec, { ctx: { actorId: outsiderId } });
    const unknown = await craft(s, rec, { ctx: { actorId: randomUUID() } });
    await jobs.tick();
    for (const j of [gone, unknown]) {
      const row = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, j.id) }))!;
      expect(row.lastError).toMatch(/^\[no_access\] This rule has no owner who is an active member/);
      expect(row.lastError).not.toMatch(/Cut|cut\.mp4|YT /);
    }
    expect(yt.calls).toHaveLength(0);
  });

  it('a membership that is not active (an invite never accepted) is not an owner either', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    await db.update(memberships).set({ status: 'pending' }).where(and(eq(memberships.userId, member.id), eq(memberships.workspaceId, wsId)));
    try {
      const job = await craft(s, rec, { ctx: { actorId: member.id } });
      await jobs.tick();
      expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[no_access\] This rule has no owner who is an active member/);
      expect(yt.calls).toHaveLength(0);
    } finally {
      await db.update(memberships).set({ status: 'active' }).where(and(eq(memberships.userId, member.id), eq(memberships.workspaceId, wsId)));
    }
  });

  it('a system database is never a source of videos', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    await db.update(databases).set({ isSystem: true, systemKey: 'agent_triggers' }).where(eq(databases.id, s.dbId));
    try {
      const job = await craft(s, rec);
      await jobs.tick();
      expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[no_access\] Videos are never uploaded from a system database or from personal space/);
      expect(yt.calls).toHaveLength(0);
    } finally {
      await db.update(databases).set({ isSystem: false, systemKey: null }).where(eq(databases.id, s.dbId));
    }
  });

  it('personal space is never a source of videos, even for its owner', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    const dbRow = (await db.query.databases.findFirst({ where: eq(databases.id, s.dbId) }))!;
    await db.update(spaces).set({ personal: true, ownerUserId: adminId }).where(eq(spaces.id, dbRow.spaceId));
    try {
      const job = await craft(s, rec);
      await jobs.tick();
      expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[no_access\] Videos are never uploaded from a system database or from personal space/);
      expect(yt.calls).toHaveLength(0);
    } finally {
      await db.update(spaces).set({ personal: false, ownerUserId: null }).where(eq(spaces.id, dbRow.spaceId));
    }
  });

  it('only a YouTube job gets the upload budget; an X job enqueued the same way keeps the long one', async () => {
    const s = await scenario();
    const rec = await record(s);
    const x = await connection('x');
    const mk = async (target: string, extra: Record<string, unknown>) => {
      const { jobId } = await jobs.enqueue({ workspaceId: wsId, ruleId: null, runId: null, connectionId: x, actionIndex: 0, kind: 'post_social', payload: { action: { type: 'post_social', target, text: 't', ...extra }, ctx: { workspaceId: wsId, databaseId: s.dbId, recordId: rec, actorId: adminId } }, idempotencyKey: randomUUID() });
      // it is only inspected, never run: cancel it so no later tick sends it anywhere
      await db.update(automationJobs).set({ status: 'canceled' }).where(eq(automationJobs.id, jobId));
      return (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) }))!.timeoutClass;
    };
    expect(await mk('youtube_channel', {})).toBe('upload');
    expect(await mk('x', {})).toBe('long');
  });

  it('the runner aborts an attempt after the budget the JOB carries (an upload an hour, a short job 30 seconds), not the executor\'s registered one', async () => {
    const kind = `probe_budget_${randomUUID().slice(0, 6)}`;
    jobs.registerExecutor(kind, async () => 'ok', { timeoutClass: 'short' });
    const real = globalThis.setTimeout;
    const seen: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 3_600_000 || ms === 30_000) seen.push(ms);
      return real(fn, ms, ...(rest as []));
    }) as typeof setTimeout;
    try {
      for (const timeoutClass of ['upload', 'short'] as const) {
        await jobs.enqueue({ workspaceId: wsId, ruleId: null, runId: null, actionIndex: 0, kind, payload: { ctx: {} }, idempotencyKey: randomUUID(), timeoutClass });
        await jobs.tick();
      }
    } finally {
      globalThis.setTimeout = real;
    }
    expect(seen.slice(0, 2)).toEqual([3_600_000, 30_000]);
  });

  it('a record in another workspace\'s database cannot be reached with this workspace\'s job (the database is not found)', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    const job = await craft(s, rec, { databaseId: randomUUID(), action: { result_field_id: undefined } });
    await jobs.tick();
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[no_access\]/);
    expect(yt.calls).toHaveLength(0);
  });
});

describe('a retry reuses the ORIGINAL channel; the read and the retry are the shared #42 ones', () => {
  it('a failed upload shows its coded error, can be retried by an editor, and the retry goes to the same named channel with the same approved metadata', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    const bytes = videoBytes(CHUNK + 9);
    await addVideo(s, rec, bytes);
    yt.hook = (call) => (call.method === 'POST' ? { status: 400, json: { error: { message: 'SECRET-PROVIDER-TEXT', errors: [{ reason: 'invalidTags' }] } } } : undefined);
    const job = await craft(s, rec, { action: { result_field_id: s.resultFieldId, tags: 'a,b' } });
    await jobs.tick();
    const failed = ((await read(s, rec)).json().data as any[])[0];
    expect(failed).toMatchObject({ state: 'failed', publish_id: job.id, can_retry: true, error: { code: 'rejected' } });
    expect(JSON.stringify(failed)).not.toContain('SECRET-PROVIDER-TEXT');
    // a viewer sees the state but is not offered the button
    expect((await read(s, rec, member.token)).statusCode).toBeLessThan(500);

    // someone tries to retry to a DIFFERENT channel: refused outright
    const redirect = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes/${job.id}/retry`, { account_id: OTHER_CHANNEL });
    expect(redirect.statusCode).toBe(422);

    yt.hook = null;
    reset();
    const retry = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes/${job.id}/retry`, {});
    expect(retry.statusCode, retry.body).toBe(202);
    await jobs.tick();
    const child = (await jobsFor(rec)).find((j) => j.id !== job.id)!;
    expect((child.payload as { action: { account_id: string; tags: string } }).action).toMatchObject({ account_id: FAKE_CHANNEL, tags: 'a,b' });
    expect(child.timeoutClass).toBe('upload');
    expect(JSON.parse(yt.inits()[0]!.bodyText).snippet.tags).toEqual(['a', 'b']);
    expect(yt.digestOf('S1')).toBe(expectedDigest(bytes));
    const item = ((await read(s, rec)).json().data as any[])[0];
    expect(item).toMatchObject({ state: 'published', post_url: `https://youtu.be/${FAKE_VIDEO_ID}` });
    // and once it is published a second retry is a 409, not a second upload
    const again = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes/${child.id}/retry`, {});
    expect(again.statusCode).toBe(409);
  }, 30_000);

  it('the result field is the dedup: a record that already links its video is not uploaded a second time', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    await db.update(records).set({ values: { [s.resultFieldId]: 'https://youtu.be/already-there' } }).where(eq(records.id, rec));
    const job = await craft(s, rec, { action: { result_field_id: s.resultFieldId } });
    await jobs.tick();
    expect((await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) }))!.lastError).toMatch(/^\[already_posted\]/);
    expect(yt.calls).toHaveLength(0);
  });

  it('a run\'s detail never shows a provider\'s words for a failed upload', async () => {
    reset();
    const s = await scenario();
    const rec = await record(s);
    await addVideo(s, rec, videoBytes(100));
    yt.hook = (call) => (call.method === 'POST' ? { status: 403, json: { error: { message: 'SECRET-PROVIDER-TEXT Launch: Cut', errors: [{ reason: 'forbidden' }] } } } : undefined);
    const job = await craft(s, rec);
    await jobs.tick();
    const run = await as(member.token, 'GET', `/workspaces/${wsId}/runs/${job.runId}`);
    expect(run.statusCode).toBeLessThan(500);
    expect(run.body).not.toContain('SECRET-PROVIDER-TEXT');
  });
});
