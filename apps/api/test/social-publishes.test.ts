import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationJobs, connections, records, user } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { PostSocialActionService } from '../src/automations/post-social.action';
import { SocialAccountsService } from '../src/connections/social-accounts.service';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #42 (rescope) — what a record's posts did, retrying a failed one, and the page picker.
 *
 * NOTHING HERE TOUCHES A REAL NETWORK. Every provider call goes through a fake fetcher assigned to the executor's and the
 * picker's own seams, every credential is a made-up string, and no account exists. The provider answers are scripted below
 * (`providerScript`), including a failure whose body carries a token-looking string and a person's name, to prove neither
 * ever reaches the record.
 *
 * The LinkedIn flag is switched on for this file only (the shared test env leaves it off; post-social.test.ts covers that).
 */
vi.hoisted(() => {
  process.env.LINKEDIN_ACTIONS_ENABLED = 'true';
});

let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let adminId: string;
let member: Person;
let viewer: Person;
let guest: Person;
let outsider: { token: string; email: string };
let wsId: string;
let otherWsId: string;
let spaceId: string;

const SECRET = 'AQXsecretTOKENvalue123';
const PERSON = 'Maya Chen';
const ORG = 'urn:li:organization:5551234';

/** What the fake network answers next, per host+path. Reset per test that needs it. */
const providerCalls: Array<{ url: string; body: string }> = [];
let providerScript: (url: string) => { status: number; json?: unknown; text?: string; headers?: Record<string, string> } = () => ({
  status: 201,
  json: { data: { id: '1850000000000000001' } },
});

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

async function connection(provider: 'x' | 'linkedin' | 'apify', createdBy = adminId, workspaceId = wsId) {
  const [row] = await db
    .insert(connections)
    .values({
      workspaceId,
      provider,
      name: `${provider} ${randomUUID().slice(0, 6)}`,
      authSealed: seal(JSON.stringify({ access_token: 'fake-token-not-real' })),
      status: 'active',
      createdBy,
    })
    .returning();
  return row!.id;
}

async function scenario() {
  const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Posts ${randomUUID().slice(0, 6)}` })).json().id as string;
  const urlField = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Post URL', type: 'url', config: {} })).json() as { id: string };
  return { dbId, resultFieldId: urlField.id, xConn: await connection('x') };
}
/** A database only the admin and an explicit grant can reach: the viewer fixture is granted `viewer` here and nothing more. */
async function restrictedScenario() {
  const s = await scenario();
  await setRestricted(app, admin.token, wsId, 'database', s.dbId);
  await grant(app, admin.token, wsId, viewer.id, { database_id: s.dbId }, 'viewer');
  return s;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const createRule = (s: Scenario, action: Record<string, unknown>) =>
  as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, {
    name: `Post ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'post_social', text: 'Launch: {Title}', ...action }],
  });
async function record(s: Scenario, title = `Rec ${randomUUID().slice(0, 6)}`) {
  const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/records`, { values: { name: title } })).json() as { id: string };
  await engine.settle(rec.id);
  return rec.id;
}
const read = (token: string, s: Scenario, rec: string, ws = wsId) => as(token, 'GET', `/workspaces/${ws}/databases/${s.dbId}/records/${rec}/social-publishes`);
/**
 * The retry route is throttled per principal (10 a minute). A test file that retries more than that from ONE session would
 * trip its own throttle, so an admin's retries rotate across fresh admin sessions: same role, separate buckets.
 */
let adminSessions: Person[] = [];
let adminCalls = 0;
async function adminToken(token: string): Promise<string> {
  if (token !== admin.token) return token;
  if (adminCalls % 6 === 0) adminSessions.push(await joinAs(app, admin.token, wsId, `Publishes Retrier ${adminSessions.length}`, 'admin'));
  adminCalls++;
  return adminSessions.at(-1)!.token;
}
const retry = async (token: string, s: Scenario, rec: string, publish: string, body: unknown = {}, ws = wsId) =>
  as(await adminToken(token), 'POST', `/workspaces/${ws}/databases/${s.dbId}/records/${rec}/social-publishes/${publish}/retry`, body);
const pending = async (rec: string) => (await db.query.approvals.findMany({ where: eq(approvals.recordId, rec) })).find((a) => a.status === 'pending')!;
const jobFor = async (rec: string) =>
  (await db.query.automationJobs.findMany({ where: eq(automationJobs.workspaceId, wsId) })).filter((j) => (j.payload as { ctx: { recordId: string } }).ctx.recordId === rec);

/** A crafted job row, for the shapes the engine cannot be made to produce on demand (legacy rows, retry chains, a missing connection). */
async function craftJob(s: Scenario, rec: string, over: { status?: string; action?: Record<string, unknown>; connectionId?: string | null; lastError?: string | null; key?: string; ruleId?: string | null; artifact?: unknown; attempts?: number; actionIndex?: number; createdAt?: Date }) {
  const [row] = await db
    .insert(automationJobs)
    .values({
      workspaceId: wsId,
      ruleId: over.ruleId ?? null,
      runId: randomUUID(),
      connectionId: over.connectionId === undefined ? s.xConn : over.connectionId,
      actionIndex: over.actionIndex ?? 0,
      kind: 'post_social',
      payload: { action: { type: 'post_social', connection_id: s.xConn, target: 'x', text: 'hello', ...(over.action ?? {}) }, ctx: { workspaceId: wsId, databaseId: s.dbId, recordId: rec, actorId: adminId } },
      idempotencyKey: over.key ?? `${randomUUID()}:${rec}:run:0`,
      status: over.status ?? 'failed',
      attempts: over.attempts ?? 1,
      lastError: over.lastError === undefined ? '[forbidden] X refused the post (HTTP 403).' : over.lastError,
      artifact: over.artifact ?? null,
      timeoutClass: 'long',
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  app.get(PostSocialActionService).fetcher = (async (url: string, init?: { body?: unknown }) => {
    providerCalls.push({ url: String(url), body: String(init?.body ?? '') });
    const r = providerScript(String(url));
    return { status: r.status, text: async () => r.text ?? '', json: async () => r.json ?? {}, headers: new Headers(r.headers ?? {}) };
  }) as unknown as typeof fetch;

  admin = await signUpUser(app, 'Publishes Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Publishes WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  member = await joinAs(app, admin.token, wsId, 'Publishes Member', 'member');
  // "Viewer" is a grant role, not a membership role (ADR-0007/0018): a member holding a viewer grant on a restricted database.
  viewer = await joinAs(app, admin.token, wsId, 'Publishes Viewer', 'member');
  // A guest must arrive with a grant; it is on a scratch database nothing below uses. The record-scoped grant the tests are about is added later.
  const scratchDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Guest scratch' })).json().id as string;
  guest = await joinAs(app, admin.token, wsId, 'Publishes Guest', 'guest', [{ database_id: scratchDb, role: 'viewer' }]);
  outsider = await signUpUser(app, 'Publishes Outsider');
  otherWsId = (await as(outsider.token, 'POST', '/workspaces', { name: 'Other WS' })).json().id;
}, 120_000);

afterAll(async () => {
  delete process.env.LINKEDIN_ACTIONS_ENABLED;
  await app.close();
});

describe('the record read and the retry, end to end through the real engine (fake network)', () => {
  it('waiting -> failed (safe error) -> retry -> published; exactly two posts reached the network, never a double', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.xConn, target: 'x', result_field_id: s.resultFieldId });
    const rec = await record(s, 'Autumn lookbook');

    // 1. waiting for approval: the approval, the NAMED connection, no job yet
    let r = (await read(admin.token, s, rec)).json().data as Array<Record<string, any>>;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ channel: 'x', target: 'x', state: 'awaiting_approval', publish_id: null, can_retry: false, error: null, post_url: null });
    expect(r[0]!.account.connection_id).toBe(s.xConn);
    expect(r[0]!.account.connection_name).toMatch(/^x /);
    expect(r[0]!.approval).toMatchObject({ status: 'pending' });

    // 2. approved, the network refuses with a body that carries a token-looking string and a person's name
    providerCalls.length = 0;
    providerScript = () => ({ status: 403, text: JSON.stringify({ message: `Invalid token ${SECRET}`, detail: `Post by ${PERSON}` }) });
    const approval = await pending(rec);
    expect((await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();

    const stored = (await jobFor(rec))[0]!;
    expect(stored.status).toBe('failed');
    expect(stored.lastError, 'the stored error is a code and a sentence').toMatch(/^\[forbidden\] /);
    for (const leaked of [SECRET, PERSON]) expect(stored.lastError).not.toContain(leaked);

    const failedBody = (await read(admin.token, s, rec)).json();
    r = failedBody.data;
    expect(r[0]).toMatchObject({ state: 'failed', can_retry: true, will_retry: false, next_attempt_at: null, post_url: null });
    expect(r[0]!.error.code).toBe('forbidden');
    expect(r[0]!.approval).toMatchObject({ status: 'approved', decided_by: adminId });
    const failedId = r[0]!.publish_id as string;
    expect(JSON.stringify(failedBody)).not.toContain(SECRET);
    expect(JSON.stringify(failedBody)).not.toContain(PERSON);

    // 3. retry: queued; pressing it twice is the same one job
    providerScript = () => ({ status: 201, json: { data: { id: '1850000000000000009' } } });
    const first = await retry(admin.token, s, rec, failedId);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ state: 'queued', retry_of: failedId });
    const again = await retry(admin.token, s, rec, failedId);
    expect(again.statusCode).toBe(202);
    expect(again.json().publish_id, 'a double press is idempotent').toBe(first.json().publish_id);
    expect((await jobFor(rec)).length, 'one failed job + ONE retry job').toBe(2);
    expect(((await read(admin.token, s, rec)).json().data as any[])[0]).toMatchObject({ state: 'queued', can_retry: false });

    // 4. published: the URL is there, nothing can be retried, and the network saw exactly two attempts
    await jobs.tick();
    r = (await read(admin.token, s, rec)).json().data;
    expect(r[0]).toMatchObject({ state: 'published', can_retry: false, error: null, post_url: 'https://x.com/i/web/status/1850000000000000009', external_id: '1850000000000000009' });
    expect(providerCalls.filter((c) => c.url.endsWith('/2/tweets'))).toHaveLength(2);

    // 5. a published post is a 409, and so is retrying the OLD failed attempt after its retry went out
    const publishedId = r[0]!.publish_id as string;
    for (const id of [publishedId, failedId]) {
      const res = await retry(admin.token, s, rec, id);
      expect(res.statusCode, res.body).toBe(409);
    }
    await jobs.tick();
    expect(providerCalls.filter((c) => c.url.endsWith('/2/tweets')), 'still two: the 409s posted nothing').toHaveLength(2);
  });

  it('sent back: the approver\'s decision and note are shown, and the retry is not offered', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.xConn, target: 'x' });
    const rec = await record(s);
    const approval = await pending(rec);
    const rejected = await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approval.id}/reject`, { reason: 'swap the photo for the walnut one' });
    expect(rejected.statusCode, rejected.body).toBeLessThan(300);
    const r = (await read(admin.token, s, rec)).json().data as any[];
    expect(r[0]).toMatchObject({ state: 'sent_back', can_retry: false, publish_id: null });
    expect(r[0].approval).toMatchObject({ status: 'rejected', reason: 'swap the photo for the walnut one', decided_by: adminId });
  });

  it('a LinkedIn page post goes out AS the named page (the author on the wire is the organization), through the real engine', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    const rule = await createRule(s, { connection_id: li, target: 'linkedin_org', account_id: ORG, require_approval: false });
    expect(rule.statusCode, rule.body).toBe(201);
    providerCalls.length = 0;
    providerScript = (url) => (url.endsWith('/rest/posts') ? { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } } : { status: 200, json: { sub: 'member-1' } });
    const rec = await record(s);
    await jobs.tick();
    const post = providerCalls.find((c) => c.url.endsWith('/rest/posts'))!;
    expect(JSON.parse(post.body).author).toBe(ORG);
    expect(providerCalls.some((c) => c.url.endsWith('/v2/userinfo')), 'the member was never looked up: the page is the author').toBe(false);
    const r = (await read(admin.token, s, rec)).json().data as any[];
    expect(r[0]).toMatchObject({ channel: 'linkedin', target: 'linkedin_org', state: 'published' });
    expect(r[0].account).toMatchObject({ connection_id: li, account_id: ORG });
  });
});

describe('save time: a post names the account it goes out as', () => {
  it('a linkedin_org action without a page 422s; with a malformed page 422s; with a page saves', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    const none = await createRule(s, { connection_id: li, target: 'linkedin_org' });
    expect(none.statusCode).toBe(422);
    expect(none.body).toContain('must name the page');
    for (const bad of ['urn:li:person:abc', 'my-company', 'urn:li:organization:']) {
      expect((await createRule(s, { connection_id: li, target: 'linkedin_org', account_id: bad })).statusCode, bad).toBe(422);
    }
    expect((await createRule(s, { connection_id: li, target: 'linkedin_org', account_id: ORG })).statusCode).toBe(201);
  });

  it('a linkedin_member action may pin the member (a person URN) but not a page; x takes no account at all', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    expect((await createRule(s, { connection_id: li, target: 'linkedin_member' })).statusCode, 'member alone is named by the connection').toBe(201);
    expect((await createRule(s, { connection_id: li, target: 'linkedin_member', account_id: 'urn:li:person:abc123' })).statusCode).toBe(201);
    expect((await createRule(s, { connection_id: li, target: 'linkedin_member', account_id: ORG })).statusCode).toBe(422);
    expect((await createRule(s, { connection_id: s.xConn, target: 'x', account_id: 'urn:li:person:abc123' })).statusCode).toBe(422);
    expect((await createRule(s, { connection_id: s.xConn, target: 'x' })).statusCode).toBe(201);
  });

  it('the approval preview names the page the post will go out as', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    await createRule(s, { connection_id: li, target: 'linkedin_org', account_id: ORG });
    const rec = await record(s);
    expect((await pending(rec)).previewText).toContain(`Post to linkedin_org as ${ORG}`);
  });
});

describe('retry guards (each one is the thing that must never happen)', () => {
  it('a legacy failed job that names no page cannot be retried (422), and is not offered', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    const rec = await record(s);
    const job = await craftJob(s, rec, { connectionId: li, action: { connection_id: li, target: 'linkedin_org' }, lastError: '[no_account] This post does not name the LinkedIn page it goes out as.' });
    expect(((await read(admin.token, s, rec)).json().data as any[])[0]).toMatchObject({ state: 'failed', can_retry: false });
    const res = await retry(admin.token, s, rec, job.id);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('does not name the account');
    expect((await jobFor(rec)).length).toBe(1);
  });

  it('a retry that tries to pick another account is a 422 and changes nothing', async () => {
    const s = await scenario();
    const rec = await record(s);
    const job = await craftJob(s, rec, {});
    for (const body of [{ account_id: ORG }, { connection_id: randomUUID() }]) {
      const res = await retry(admin.token, s, rec, job.id, body);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain('approved for');
    }
    expect((await jobFor(rec)).length).toBe(1);
  });

  it('a retry reuses the ORIGINAL connection and account, byte for byte', async () => {
    const s = await scenario();
    const li = await connection('linkedin');
    const rec = await record(s);
    const job = await craftJob(s, rec, { connectionId: li, action: { connection_id: li, target: 'linkedin_org', account_id: ORG } });
    const res = await retry(admin.token, s, rec, job.id);
    expect(res.statusCode, res.body).toBe(202);
    const child = (await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, res.json().publish_id) }))!;
    expect(child.connectionId).toBe(li);
    expect(child.payload).toEqual(job.payload);
  });

  it.each([
    ['queued', 'still queued'],
    ['running', 'being sent right now'],
  ])('only a FAILED post retries: a %s one is a 409', async (status, words) => {
    const s = await scenario();
    const rec = await record(s);
    const job = await craftJob(s, rec, { status, lastError: null });
    const res = await retry(admin.token, s, rec, job.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(words);
  });

  it('a post whose link is already on the record is posted: 409, not a second post', async () => {
    const s = await scenario();
    const rec = await record(s);
    await db.update(records).set({ values: { [s.resultFieldId]: 'https://x.com/i/web/status/1' } }).where(eq(records.id, rec));
    const job = await craftJob(s, rec, { action: { result_field_id: s.resultFieldId } });
    expect(((await read(admin.token, s, rec)).json().data as any[])[0].can_retry).toBe(false);
    const res = await retry(admin.token, s, rec, job.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('already has a link');
  });

  it('the connection was removed: 404 and not offered', async () => {
    const s = await scenario();
    const rec = await record(s);
    const job = await craftJob(s, rec, { connectionId: null });
    expect(((await read(admin.token, s, rec)).json().data as any[])[0].can_retry).toBe(false);
    expect((await retry(admin.token, s, rec, job.id)).statusCode).toBe(404);
  });

  it('a newer attempt on the same channel supersedes an older failed one (409)', async () => {
    const s = await scenario();
    const rec = await record(s);
    const older = await craftJob(s, rec, {});
    await craftJob(s, rec, { status: 'failed', key: `${randomUUID()}:other`, createdAt: new Date(Date.now() + 5_000) });
    const res = await retry(admin.token, s, rec, older.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('newer attempt');
  });

  it('the manual retry cap: after five retries of one post the next is a 409', async () => {
    const s = await scenario();
    const rec = await record(s);
    const base = `${randomUUID()}:${rec}:run:0`;
    let last = await craftJob(s, rec, { key: base });
    for (let i = 1; i <= 5; i++) last = await craftJob(s, rec, { key: `${base}:retry-of:${last.id}` });
    expect(((await read(admin.token, s, rec)).json().data as any[])[0]).toMatchObject({ state: 'failed', can_retry: false });
    const res = await retry(admin.token, s, rec, last.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('retried 5 times');
  });

  it('the retry route is rate limited per person: the eleventh call inside a minute is a 429', async () => {
    const s = await scenario();
    const rec = await record(s);
    const job = await craftJob(s, rec, { status: 'queued', lastError: null });
    const person = await joinAs(app, admin.token, wsId, 'Publishes Hammer', 'admin');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await retry(person.token, s, rec, job.id)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 409)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('an unknown, malformed or other-record publish id is a 404', async () => {
    const s = await scenario();
    const rec = await record(s);
    const otherRec = await record(s);
    const theirs = await craftJob(s, otherRec, {});
    for (const id of [randomUUID(), 'not-a-uuid', theirs.id]) {
      expect((await retry(admin.token, s, rec, id)).statusCode, id).toBe(404);
    }
    expect((await jobFor(otherRec)).filter((j) => j.idempotencyKey.includes(':retry-of:'))).toHaveLength(0);
  });
});

describe('who may read and who may retry', () => {
  it('read follows the record: a viewer reads it, can_retry is false for them; retry needs edit on the record (viewer 403, an editor ok)', async () => {
    const s = await restrictedScenario();
    await grant(app, admin.token, wsId, member.id, { database_id: s.dbId }, 'editor');
    const rec = await record(s);
    const job = await craftJob(s, rec, {});
    expect(((await read(admin.token, s, rec)).json().data as any[])[0].can_retry, 'admin control').toBe(true);
    const asViewer = await read(viewer.token, s, rec);
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json().data[0]).toMatchObject({ state: 'failed', can_retry: false });
    const denied = await retry(viewer.token, s, rec, job.id);
    expect(denied.statusCode).toBe(403);
    expect((await jobFor(rec)).filter((j) => j.idempotencyKey.includes(':retry-of:'))).toHaveLength(0);
    expect((await retry(member.token, s, rec, job.id)).statusCode).toBe(202);
  });

  it('a record-scoped GUEST reads the record they hold and nothing else; they cannot retry', async () => {
    const s = await scenario();
    const mine = await record(s);
    const notMine = await record(s);
    await craftJob(s, mine, {});
    await craftJob(s, notMine, {});
    // The guest holds a viewer grant on ONE record only.
    const g = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guest.id, record_id: mine, role: 'viewer' });
    expect(g.statusCode, g.body).toBeLessThan(300);
    const own = await read(guest.token, s, mine);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data).toHaveLength(1);
    expect(own.json().data[0].can_retry).toBe(false);
    const sibling = await read(guest.token, s, notMine);
    expect(sibling.statusCode, 'a sibling record in the same database is not theirs').toBeGreaterThanOrEqual(403);
    expect(sibling.statusCode).toBeLessThanOrEqual(404);
    expect(sibling.body).not.toContain('forbidden] X refused');
    const job = (await jobFor(mine))[0]!;
    expect((await retry(guest.token, s, mine, job.id)).statusCode).toBe(403);
  });

  it("another workspace's record is a 404 from your own workspace, and a foreign workspace path is refused", async () => {
    const s = await scenario();
    const rec = await record(s);
    const job = await craftJob(s, rec, {});
    // The outsider owns their own workspace, and asks about ws1's database and record through THEIR workspace path.
    const viaOwn = await read(outsider.token, s, rec, otherWsId);
    expect(viaOwn.statusCode).toBe(404);
    expect((await retry(outsider.token, s, rec, job.id, {}, otherWsId)).statusCode).toBe(404);
    // And through ws1's path they are not a member at all.
    const viaTheirs = await read(outsider.token, s, rec);
    expect([403, 404]).toContain(viaTheirs.statusCode);
    expect(viaTheirs.body).not.toContain(job.id);
    expect((await jobFor(rec)).filter((j) => j.idempotencyKey.includes(':retry-of:'))).toHaveLength(0);
  });

  it('a signed-out caller gets nothing', async () => {
    const s = await scenario();
    const rec = await record(s);
    const res = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/databases/${s.dbId}/records/${rec}/social-publishes` });
    expect(res.statusCode).toBe(401);
  });
});

describe('what the read shows', () => {
  it("channels are never merged (a published X post and a failed LinkedIn page post are two entries), and a later approval REPLACES an older outcome of its channel", async () => {
    const s = await scenario();
    const rec = await record(s);
    const li = await connection('linkedin');
    // Rules are not needed for the channel key: the action index tells two channels of one record apart.
    await craftJob(s, rec, { actionIndex: 0, status: 'succeeded', lastError: null, artifact: { url: 'https://x.com/i/web/status/5', external_id: '5' } });
    await craftJob(s, rec, { actionIndex: 1, connectionId: li, action: { connection_id: li, target: 'linkedin_org', account_id: ORG }, lastError: '[forbidden] LinkedIn refused the post (HTTP 403).' });
    let r = (await read(admin.token, s, rec)).json().data as any[];
    expect(r).toHaveLength(2);
    expect(r.map((e) => [e.channel, e.state]).sort()).toEqual([['linkedin', 'failed'], ['x', 'published']]);

    // The X rule fires again later and is waiting for approval: that is the channel's state now, not the old link.
    await db.insert(approvals).values({
      workspaceId: wsId,
      recordId: rec,
      actionIndex: 0,
      actionSnapshot: { action: { type: 'post_social', connection_id: s.xConn, target: 'x', text: 'again' }, ctx: { workspaceId: wsId, databaseId: s.dbId, recordId: rec, actorId: adminId } },
      previewText: 'Post to x: again',
      approverId: adminId,
    });
    r = (await read(admin.token, s, rec)).json().data as any[];
    expect(r).toHaveLength(2);
    expect(r.find((e) => e.channel === 'x')).toMatchObject({ state: 'awaiting_approval', post_url: null });
  });

  it('an automatic retry in flight shows its attempt and when the next one is, with no button', async () => {
    const s = await scenario();
    const rec = await record(s);
    await craftJob(s, rec, { status: 'queued', attempts: 2, lastError: '[provider_unavailable] X refused the post (HTTP 503).' });
    const e = ((await read(admin.token, s, rec)).json().data as any[])[0];
    expect(e).toMatchObject({ state: 'queued', attempt: 2, max_attempts: 5, will_retry: true, can_retry: false });
    expect(e.next_attempt_at).toEqual(expect.any(String));
    expect(e.error.code).toBe('provider_unavailable');
  });

  it("an OLD row whose error is the network's raw response is never passed through: only the HTTP status survives", async () => {
    const s = await scenario();
    const rec = await record(s);
    await craftJob(s, rec, { lastError: `X post failed: HTTP 403 — {"detail":"Invalid token ${SECRET} for ${PERSON}"}` });
    const body = (await read(admin.token, s, rec)).json();
    expect(body.data[0].error).toEqual({ code: 'unknown', message: 'The network refused the post (HTTP 403).' });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(PERSON);
  });

  it('a record nothing was ever posted from reads as an empty list, not an error', async () => {
    const s = await scenario();
    const rec = await record(s);
    const res = await read(admin.token, s, rec);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
  });
});

describe('the account picker: GET /connections/{id}/social-accounts', () => {
  const picker = (token: string, id: string, query = '') => as(token, 'GET', `/workspaces/${wsId}/connections/${id}/social-accounts${query}`);
  const social = () => app.get(SocialAccountsService);
  let networkCalls: string[] = [];
  let orgAnswer: { status: number; json?: unknown } = { status: 200 };

  beforeAll(() => {
    social().fetcher = (async (url: string) => {
      networkCalls.push(url);
      if (url.endsWith('/v2/userinfo')) return { status: 200, json: async () => ({ sub: 'm-1', name: PERSON }), text: async () => `{"leak":"${SECRET}"}` };
      if (url.includes('/rest/organizationAcls')) {
        return {
          status: orgAnswer.status,
          json: async () => orgAnswer.json ?? {},
          text: async () => `{"leak":"${SECRET}"}`,
        };
      }
      if (url.endsWith('/2/users/me')) return { status: 200, json: async () => ({ data: { id: '99', name: 'Pinewood', username: 'pinewoodstudio' } }), text: async () => '' };
      return { status: 500, json: async () => ({}), text: async () => '' };
    }) as never;
  });

  const orgs = {
    status: 200,
    json: {
      elements: [
        { organization: ORG, 'organization~': { id: 5551234, localizedName: 'Pinewood Studio', vanityName: 'pinewood-studio' } },
        { organization: ORG, 'organization~': { id: 5551234, localizedName: 'Pinewood Studio (dup)' } },
        { organization: 'urn:li:organization:777', 'organization~': { id: 777, localizedName: 'Lumen & Loom' } },
        { organization: 'urn:li:person:nope' },
      ],
    },
  };

  it('lists the member and the pages they administer: id, name, type, and nothing secret; cached; refresh asks again', async () => {
    const li = await connection('linkedin');
    orgAnswer = orgs;
    networkCalls = [];
    const res = await picker(admin.token, li);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { id: 'urn:li:person:m-1', name: PERSON, type: 'member' },
        { id: ORG, name: 'Pinewood Studio', type: 'organization', handle: 'pinewood-studio' },
        { id: 'urn:li:organization:777', name: 'Lumen & Loom', type: 'organization' },
      ],
      warnings: [],
      cached: false,
    });
    expect(res.body).not.toContain('fake-token-not-real');
    expect(res.body).not.toContain(SECRET);
    const callsAfterFirst = networkCalls.length;
    const cached = await picker(admin.token, li);
    expect(cached.json().cached).toBe(true);
    expect(networkCalls.length, 'the cache answered; the network was not asked').toBe(callsAfterFirst);
    const fresh = await picker(admin.token, li, '?refresh=true');
    expect(fresh.json().cached).toBe(false);
    expect(networkCalls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('a connection that cannot list pages still lists the member, with a plain warning', async () => {
    const li = await connection('linkedin');
    orgAnswer = { status: 403 };
    const res = await picker(admin.token, li);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: 'urn:li:person:m-1', name: PERSON, type: 'member' }]);
    expect(res.json().warnings[0].code).toBe('organizations_unavailable');
    expect(res.body).not.toContain(SECRET);
  });

  it("the network failing is a 502 whose message is ours, never the network's response", async () => {
    const li = await connection('linkedin');
    orgAnswer = { status: 500 };
    const res = await picker(admin.token, li);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('HTTP 500');
    expect(res.body).not.toContain(SECRET);
  });

  it('X lists the one account the connection posts as', async () => {
    const x = await connection('x');
    const res = await picker(admin.token, x);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: '99', name: '@pinewoodstudio', type: 'x_account', handle: 'pinewoodstudio' }]);
  });

  it('permission: a plain member is refused (403), the person who connected it is not, an admin is not', async () => {
    const li = await connection('linkedin', adminId);
    orgAnswer = orgs;
    expect((await picker(member.token, li)).statusCode).toBe(403);
    expect((await picker(viewer.token, li)).statusCode).toBe(403);
    expect((await picker(guest.token, li)).statusCode).toBe(403);
    const mine = await connection('linkedin', member.id);
    expect((await picker(member.token, mine)).statusCode, 'the creator of the connection').toBe(200);
    expect((await picker(admin.token, li)).statusCode).toBe(200);
  });

  it("another workspace's connection, an unknown one and a non-social one are refused without confirming anything", async () => {
    const theirs = await connection('linkedin', adminId, otherWsId);
    expect((await picker(admin.token, theirs)).statusCode, 'foreign workspace: a 404, not a 403').toBe(404);
    // The oracle: a plain member would get a 403 if the permission check ran before the workspace lookup, and a 403 confirms the id exists.
    expect((await picker(member.token, theirs)).statusCode, 'a member is told it does not exist, not that they may not see it').toBe(404);
    expect((await picker(admin.token, randomUUID())).statusCode).toBe(404);
    const apify = await connection('apify');
    expect((await picker(admin.token, apify)).statusCode).toBe(422);
  });

  it('a signed-out caller gets nothing', async () => {
    const li = await connection('linkedin');
    const res = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/connections/${li}/social-accounts` });
    expect(res.statusCode).toBe(401);
  });
});

describe('the run detail never returns the network\'s raw response for a post (GET /runs/:id)', () => {
  it('an old row whose last_error is raw provider text reads back as a sentence with only the status, for a plain member; a new row reads as its code sentence', async () => {
    const s = await scenario();
    await createRule(s, { connection_id: s.xConn, target: 'x', require_approval: false });
    providerScript = () => ({ status: 403, text: `Invalid token ${SECRET} for ${PERSON}` });
    const rec = await record(s);
    await jobs.tick();
    const job = (await jobFor(rec))[0]!;
    expect(job.status).toBe('failed');
    const run = () => as(member.token, 'GET', `/workspaces/${wsId}/runs/${job.runId}`);

    const fresh = await run();
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().actions[0].last_error).toBe('X refused the post (HTTP 403). Usually the X app\'s tier does not allow posting.');

    // The same row as it was stored before the executor wrote codes.
    await db.update(automationJobs).set({ lastError: `X post failed: HTTP 403 — {"detail":"Invalid token ${SECRET} for ${PERSON}"}` }).where(eq(automationJobs.id, job.id));
    const legacy = await run();
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().actions[0].last_error).toBe('The network refused the post (HTTP 403).');
    expect(legacy.body).not.toContain(SECRET);
    expect(legacy.body).not.toContain(PERSON);
  });
});
