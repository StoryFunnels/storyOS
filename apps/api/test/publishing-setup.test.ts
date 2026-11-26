import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { activityEvents, approvals, automationJobs, automations, connections, fields, selectOptions, user } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { PostSocialActionService } from '../src/automations/post-social.action';
import { PublishingController } from '../src/automations/publishing.controller';
import { SocialAccountsService } from '../src/connections/social-accounts.service';
import { SOCIAL_COMMAND_CENTER_PACK } from '../src/packs/social-command-center';
import { TokensService } from '../src/tokens/tokens.service';
import { NO_RUN_CREDENTIAL_KEY } from '../src/auth/token-scope.guard';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #456 - the guided "Turn on publishing" API, on the Social Command Center's Posts database.
 *
 * NOTHING HERE TOUCHES A REAL NETWORK. The accounts a connection can post as come from a fake fetcher assigned to the picker's own seam,
 * the executor's fetcher is a recorder that must stay empty, every credential is a made-up string and no account exists.
 *
 * What is guarded, and why each is a test rather than a hope:
 *  - the prerequisite matrix: every missing piece is a 422 with ITS OWN code, and several at once come back together;
 *  - what must be KEPT: the pack installs with nothing switched on and no publish rule, and a fresh read changes nothing;
 *  - nothing posts from an unnamed account, and the named one is checked against what the connection can really post as;
 *  - idempotent, audited with the actor, one rule per network, pause then resume reuses the same rule;
 *  - never posts: enabling creates no job and calls no network; the rule then works through the real engine (Scheduled -> an approval);
 *  - a person only: guest, plain member, viewer grant, agent token and MCP token are all refused; another workspace is a 404.
 */
vi.hoisted(() => {
  process.env.LINKEDIN_ACTIONS_ENABLED = 'true';
});

let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let admin: { token: string; email: string };
let adminId: string;
let member: Person;
let viewer: Person;
let guest: Person;
let outsider: { token: string; email: string };
let wsId: string;
let postsDb: string;

/** Every call the fake network saw, so "nothing posted" is an assertion about calls and not an absence of a log line. */
const accountCalls: string[] = [];
const postCalls: string[] = [];
let accountsStatus = 200;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const get = (token: string, db_ = postsDb, ws = wsId) => as(token, 'GET', `/workspaces/${ws}/databases/${db_}/publishing`);
const enable = async (token: string, body: Record<string, unknown>, db_ = postsDb, ws = wsId) => as(await throttleSafe(token), 'POST', `/workspaces/${ws}/databases/${db_}/publishing/enable`, body);
const disable = (token: string, body: Record<string, unknown> = {}, db_ = postsDb, ws = wsId) => as(token, 'POST', `/workspaces/${ws}/databases/${db_}/publishing/disable`, body);

/**
 * enable is throttled per principal (10 a minute). A file that calls it more than that from ONE admin session would trip its own throttle,
 * so the admin's calls rotate across fresh admin sessions: same role, separate buckets.
 */
let adminSessions: Person[] = [];
let adminCalls = 0;
async function throttleSafe(token: string): Promise<string> {
  if (token !== admin.token) return token;
  if (adminCalls % 6 === 0) adminSessions.push(await joinAs(app, admin.token, wsId, `Publishing Admin ${adminSessions.length}`, 'admin'));
  adminCalls++;
  return adminSessions.at(-1)!.token;
}

async function connection(provider: 'x' | 'linkedin', createdBy = adminId, workspaceId = wsId) {
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

async function installPack(token: string, ws: string): Promise<string> {
  const res = await as(token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: SOCIAL_COMMAND_CENTER_PACK.manifest });
  expect(res.statusCode, res.body).toBeLessThan(300);
  const dbs = (await as(token, 'GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  return dbs.find((d) => d.name === 'Posts')!.id;
}
const rulesOn = async (dbId: string) => (await db.query.automations.findMany({ where: eq(automations.databaseId, dbId) })).filter((r) => JSON.stringify(r.actions).includes('post_social'));
const eventsOf = async (type: string) => (await db.query.activityEvents.findMany({ where: and(eq(activityEvents.workspaceId, wsId), eq(activityEvents.type, type)) }));
const unmetOf = (res: { json: () => { error?: { meta?: { unmet?: Array<{ code: string; field?: string }> } } } }) => res.json().error?.meta?.unmet ?? [];
const unmetCodes = (res: { json: () => { error?: { meta?: { unmet?: Array<{ code: string }> } } } }) => unmetOf(res as never).map((u) => u.code).sort();

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  // The picker's whole provider surface. LinkedIn answers a member and one page; X answers one account.
  app.get(SocialAccountsService).fetcher = (async (url: string) => {
    accountCalls.push(String(url));
    if (accountsStatus !== 200) return { status: accountsStatus, json: async () => ({}), text: async () => '' };
    const u = String(url);
    if (u.includes('/v2/userinfo')) return { status: 200, json: async () => ({ sub: 'abc123', name: 'Maya Chen' }), text: async () => '' };
    if (u.includes('organizationAcls')) {
      return { status: 200, json: async () => ({ elements: [{ organization: 'urn:li:organization:5551234', 'organization~': { id: 5551234, localizedName: 'Acme Co', vanityName: 'acme' } }] }), text: async () => '' };
    }
    if (u.includes('/2/users/me')) return { status: 200, json: async () => ({ data: { id: '777', name: 'Acme', username: 'acme_fake' } }), text: async () => '' };
    return { status: 404, json: async () => ({}), text: async () => '' };
  }) as never;
  // The executor must never be reached by anything in this file: a recorder, asserted empty.
  app.get(PostSocialActionService).fetcher = (async (url: string) => {
    postCalls.push(String(url));
    return { status: 201, json: async () => ({}), text: async () => '', headers: new Headers() };
  }) as unknown as typeof fetch;

  admin = await signUpUser(app, 'Publishing Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Publishing WS' })).json().id;
  postsDb = await installPack(admin.token, wsId);
  member = await joinAs(app, admin.token, wsId, 'Publishing Member', 'member');
  viewer = await joinAs(app, admin.token, wsId, 'Publishing Viewer', 'member');
  const scratch = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id, name: 'Guest scratch' })).json().id as string;
  guest = await joinAs(app, admin.token, wsId, 'Publishing Guest', 'guest', [{ database_id: scratch, role: 'viewer' }]);
  await grant(app, admin.token, wsId, viewer.id, { database_id: postsDb }, 'viewer');
  outsider = await signUpUser(app, 'Publishing Outsider');
  await as(outsider.token, 'POST', '/workspaces', { name: 'Other WS' });
}, 120_000);

afterAll(async () => {
  delete process.env.LINKEDIN_ACTIONS_ENABLED;
  await app.close();
});

describe('what must be KEPT: a fresh install is switched off and a read changes nothing', () => {
  it('the pack installs with no publish rule and every rule it did create switched off', async () => {
    expect(await rulesOn(postsDb)).toHaveLength(0);
    const all = await db.query.automations.findMany({ where: eq(automations.databaseId, postsDb) });
    for (const r of all) expect(r.enabled, r.name).toBe(false);
    expect(await db.query.automationJobs.findMany({ where: eq(automationJobs.workspaceId, wsId) })).toHaveLength(0);
  });

  it('GET: applicable, not set up, the pack\'s own field ids resolved, a draft that names no connection', async () => {
    const before = (await db.query.automations.findMany({ where: eq(automations.databaseId, postsDb) })).length;
    const res = await get(admin.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ applicable: true, state: 'not_set_up', can_manage: true, can_skip_approval: true, rules: [], unmet: [] });
    expect(body.fields).toEqual({
      status_field_id: expect.any(String),
      scheduled_option_id: expect.any(String),
      text_field_id: expect.any(String),
      media_field_id: expect.any(String),
      post_url_field_id: expect.any(String),
    });
    expect(body.draft.action).toMatchObject({ type: 'post_social', text: '{Text}', require_approval: true, result_field_id: body.fields.post_url_field_id });
    expect(body.draft.action.connection_id).toBeUndefined();
    expect(body.draft.trigger).toEqual({ type: 'record_updated', field_id: body.fields.status_field_id });
    expect(body.channels.map((c: { provider: string }) => c.provider)).toEqual(['linkedin', 'x']);
    expect(body.channels[0]).toMatchObject({ posting_enabled: true, targets: ['linkedin_org', 'linkedin_member'] });
    expect(body.channels[1]).toMatchObject({ posting_enabled: true, targets: ['x'] });
    expect(['connectable', 'operator_config', 'cloud_only']).toContain(body.channels[0].availability);
    expect(await db.query.automations.findMany({ where: eq(automations.databaseId, postsDb) })).toHaveLength(before);
  });

  it('a database that is not the pack\'s Posts is not applicable: read says so, enable and pause refuse, nothing is created', async () => {
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const lookalike = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Posts' })).json().id as string;
    const read = await get(admin.token, lookalike);
    expect(read.json()).toMatchObject({ applicable: false, state: 'not_set_up', rules: [], channels: [], fields: null, draft: null });
    expect(read.json().unmet.map((u: { code: string }) => u.code)).toEqual(['not_applicable']);
    const x = await connection('x');
    const res = await enable(admin.token, { connection_id: x, target: 'x' }, lookalike);
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['not_applicable']);
    expect((await disable(admin.token, {}, lookalike)).statusCode).toBe(422);
    expect(await rulesOn(lookalike)).toHaveLength(0);
  });
});

describe('the prerequisite matrix: each missing piece is a 422 with its own code', () => {
  it('a connection that does not exist, and one that belongs to another workspace, are both "missing"', async () => {
    const otherWs = (await as(outsider.token, 'GET', '/workspaces')).json()[0].id as string;
    const theirs = await connection('x', adminId, otherWs);
    for (const id of [randomUUID(), theirs]) {
      const res = await enable(admin.token, { connection_id: id, target: 'x' });
      expect(res.statusCode).toBe(422);
      expect(unmetCodes(res)).toEqual(['connection_missing']);
    }
    expect(await rulesOn(postsDb)).toHaveLength(0);
  });

  it('a connection of the wrong provider for the target', async () => {
    const x = await connection('x');
    const li = await connection('linkedin');
    expect(unmetCodes(await enable(admin.token, { connection_id: x, target: 'linkedin_org', account_id: 'urn:li:organization:5551234' }))).toEqual(['connection_wrong_provider']);
    expect(unmetCodes(await enable(admin.token, { connection_id: li, target: 'x' }))).toEqual(['connection_wrong_provider']);
  });

  it('a LinkedIn page with no account named is refused: nothing posts from an unnamed account', async () => {
    const li = await connection('linkedin');
    accountCalls.length = 0;
    const res = await enable(admin.token, { connection_id: li, target: 'linkedin_org' });
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['account_required']);
    expect(await rulesOn(postsDb)).toHaveLength(0);
  });

  it('an account the connection cannot post as is refused, however well-formed the URN looks', async () => {
    const li = await connection('linkedin');
    for (const body of [
      { connection_id: li, target: 'linkedin_org', account_id: 'urn:li:organization:999' },
      { connection_id: li, target: 'linkedin_member', account_id: 'urn:li:person:someoneelse' },
      { connection_id: await connection('x'), target: 'x', account_id: '777' },
    ]) {
      const res = await enable(admin.token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(unmetCodes(res)).toEqual(['account_not_found']);
    }
    expect(await rulesOn(postsDb)).toHaveLength(0);
  });

  it('when the network cannot say which accounts exist, nothing is assumed', async () => {
    const x = await connection('x');
    accountsStatus = 500;
    try {
      const res = await enable(admin.token, { connection_id: x, target: 'x' });
      expect(res.statusCode).toBe(422);
      expect(unmetCodes(res)).toEqual(['accounts_unavailable']);
    } finally {
      accountsStatus = 200;
    }
    expect(await rulesOn(postsDb)).toHaveLength(0);
  });

  it('approval off is a workspace admin\'s call: a member with create access on Posts is refused, an admin is not', async () => {
    await grant(app, admin.token, wsId, member.id, { database_id: postsDb }, 'creator');
    const own = await connection('x', member.id);
    const res = await enable(member.token, { connection_id: own, target: 'x', require_approval: false });
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['approval_off_needs_admin']);
    expect(await rulesOn(postsDb)).toHaveLength(0);
  });

  it('several problems come back together, not one per attempt', async () => {
    await grant(app, admin.token, wsId, member.id, { database_id: postsDb }, 'creator');
    const x = await connection('x', member.id);
    const res = await enable(member.token, { connection_id: x, target: 'linkedin_org', require_approval: false });
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['approval_off_needs_admin', 'connection_wrong_provider']);
    expect(res.json().error.code).toBe('publishing_prerequisites_unmet');
  });

  it('a field the pack made that is gone, or a Scheduled option that is gone, blocks turning it on and says which', async () => {
    const ws2 = (await as(admin.token, 'POST', '/workspaces', { name: 'Publishing WS2' })).json().id as string;
    const db2 = await installPack(admin.token, ws2);
    const x2 = await connection('x', adminId, ws2);
    // Scheduled option removed
    const status = (await db.query.fields.findMany({ where: eq(fields.databaseId, db2) })).find((f) => f.apiName === 'status')!;
    const scheduled = (await db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, status.id) })).find((o) => o.label === 'Scheduled')!;
    await db.delete(selectOptions).where(eq(selectOptions.id, scheduled.id));
    let res = await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${db2}/publishing/enable`, { connection_id: x2, target: 'x' });
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['scheduled_option_missing']);
    const read = (await get(admin.token, db2, ws2)).json();
    expect(read.unmet.map((u: { code: string }) => u.code)).toEqual(['scheduled_option_missing']);
    expect(read.fields).toBeNull();
    expect(read.draft).toBeNull();
    // Media field removed as well
    const media = (await db.query.fields.findMany({ where: eq(fields.databaseId, db2) })).find((f) => f.apiName === 'media')!;
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws2}/databases/${db2}/fields/${media.id}`)).statusCode).toBeLessThan(300);
    res = await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${db2}/publishing/enable`, { connection_id: x2, target: 'x' });
    expect(unmetCodes(res)).toEqual(['field_missing', 'scheduled_option_missing']);
    expect(unmetOf(res as never).find((u) => u.code === 'field_missing')!.field).toBe('media');
    expect(await rulesOn(db2)).toHaveLength(0);
  });
});

describe('turning it on: named account, idempotent, audited, one rule per network', () => {
  it('X: saves the rule from the pack\'s own ids, on, with approval, naming the connection; audited with the actor', async () => {
    const x = await connection('x');
    const setup = (await get(admin.token)).json();
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${postsDb}/publishing/enable`, { connection_id: x, target: 'x' });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.changed).toBe(true);
    expect(out.rule).toMatchObject({ enabled: true, target: 'x', connection_id: x, account_id: null, require_approval: true, created_by: adminId, enabled_by: adminId });
    expect(out.rule.name).toContain('@acme_fake');

    const [row] = await rulesOn(postsDb);
    expect(row!.enabled).toBe(true);
    expect(row!.trigger).toEqual({ type: 'record_updated', field_id: setup.fields.status_field_id });
    expect(row!.condition).toEqual({ field: 'status', op: 'eq', value: setup.fields.scheduled_option_id });
    expect(row!.actions).toEqual([
      expect.objectContaining({ type: 'post_social', connection_id: x, target: 'x', text: '{Text}', media_field_id: setup.fields.media_field_id, result_field_id: setup.fields.post_url_field_id, require_approval: true }),
    ]);

    const events = await eventsOf('publishing.enabled');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: adminId, source: 'human' });
    expect(events[0]!.payload).toMatchObject({ object: { kind: 'publishing', id: out.rule.id }, target: 'x', connection_id: x, require_approval: true });
    // and the audit log reads it with the query it already has
    const log = (await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log?limit=50&type=publishing.enabled,publishing.disabled`)).json();
    expect((log.data ?? log.events ?? log).length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: the same call again changes nothing, adds no rule and no second audit event', async () => {
    const [existing] = await rulesOn(postsDb);
    const conn = (existing!.actions as Array<{ connection_id: string }>)[0]!.connection_id;
    const before = (await eventsOf('publishing.enabled')).length;
    const res = await enable(admin.token, { connection_id: conn, target: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false, rule: { id: existing!.id, enabled: true } });
    expect(await rulesOn(postsDb)).toHaveLength(1);
    expect((await eventsOf('publishing.enabled')).length).toBe(before);
  });

  it('a second X connection is refused while one is on: one publish rule per network (no double posting)', async () => {
    const other = await connection('x');
    const res = await enable(admin.token, { connection_id: other, target: 'x' });
    expect(res.statusCode).toBe(422);
    expect(unmetCodes(res)).toEqual(['already_configured']);
    expect(await rulesOn(postsDb)).toHaveLength(1);
  });

  it('LinkedIn page: the named page is stored on the rule and named in it; a profile post is pinned to the member even when none was named', async () => {
    const li = await connection('linkedin');
    const page = await enable(admin.token, { connection_id: li, target: 'linkedin_org', account_id: 'urn:li:organization:5551234' });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().rule).toMatchObject({ target: 'linkedin_org', account_id: 'urn:li:organization:5551234', connection_id: li, enabled: true });
    expect(page.json().rule.name).toContain('Acme Co');

    const profile = await enable(admin.token, { connection_id: li, target: 'linkedin_member' });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().rule).toMatchObject({ target: 'linkedin_member', account_id: 'urn:li:person:abc123' });
    expect((await rulesOn(postsDb)).filter((r) => (r.actions as Array<{ account_id?: string }>)[0]!.account_id === undefined && JSON.stringify(r.actions).includes('"linkedin_')))
      .toHaveLength(0);
  });

  it('NEVER POSTS: enabling created no job and reached no network for a post; only account lookups were made', async () => {
    expect(await db.query.automationJobs.findMany({ where: eq(automationJobs.workspaceId, wsId) })).toHaveLength(0);
    expect(postCalls).toEqual([]);
    expect(accountCalls.length).toBeGreaterThan(0);
    for (const u of accountCalls) expect(u, 'a lookup, never a post').not.toMatch(/\/posts|\/tweets|ugcPosts|shares/);
  });

  it('the saved rule works through the real engine: a post moved to Scheduled waits for approval, still nothing reaches the network', async () => {
    const setup = (await get(admin.token)).json();
    const made = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${postsDb}/records`, { values: { name: 'Launch', text: [{ type: 'paragraph', content: [{ type: 'text', text: 'We shipped it', styles: {} }] }] } });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const rec = made.json() as { id: string };
    await engine.settle(rec.id);
    expect(await db.query.approvals.findMany({ where: eq(approvals.recordId, rec.id) })).toHaveLength(0);
    const set = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${postsDb}/records/${rec.id}`, { values: { status: setup.fields.scheduled_option_id } });
    expect(set.statusCode, set.body).toBeLessThan(300);
    await engine.settle(rec.id);
    const pending = (await db.query.approvals.findMany({ where: eq(approvals.recordId, rec.id) })).filter((a) => a.status === 'pending');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    // The pre-filled `{Text}` reaches the approver as the words of the post, not as a rich-text structure.
    for (const a of pending) expect((a.actionSnapshot as { action: { text: string } }).action.text).toBe('We shipped it');
    for (const a of pending) expect(a.previewText).toContain('We shipped it');
    expect(postCalls).toEqual([]);
  });
});

describe('pausing', () => {
  it('pauses every publish rule, deletes none, is idempotent, and is audited', async () => {
    const before = (await rulesOn(postsDb)).length;
    const res = await disable(admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().changed.length).toBe(before);
    for (const r of await rulesOn(postsDb)) expect(r.enabled).toBe(false);
    expect(await rulesOn(postsDb)).toHaveLength(before);
    expect((await eventsOf('publishing.disabled')).length).toBe(before);
    expect((await get(admin.token)).json().state).toBe('paused');

    const again = await disable(admin.token);
    expect(again.statusCode).toBe(200);
    expect(again.json().changed).toEqual([]);
    expect((await eventsOf('publishing.disabled')).length).toBe(before);
  });

  it('turning it back on reuses the paused rule (no duplicate) and is audited again', async () => {
    const [x] = (await rulesOn(postsDb)).filter((r) => (r.actions as Array<{ target: string }>)[0]!.target === 'x');
    const conn = (x!.actions as Array<{ connection_id: string }>)[0]!.connection_id;
    const before = (await rulesOn(postsDb)).length;
    const res = await enable(admin.token, { connection_id: conn, target: 'x' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, rule: { id: x!.id, enabled: true } });
    expect(await rulesOn(postsDb)).toHaveLength(before);
    expect((await get(admin.token)).json().state).toBe('on');
  });

  it('pausing one network leaves the other on', async () => {
    const page = (await rulesOn(postsDb)).find((r) => (r.actions as Array<{ target: string }>)[0]!.target === 'linkedin_org')!;
    const pageConn = (page.actions as Array<{ connection_id: string }>)[0]!.connection_id;
    expect((await enable(admin.token, { connection_id: pageConn, target: 'linkedin_org', account_id: 'urn:li:organization:5551234' })).statusCode).toBe(200);
    const res = await disable(admin.token, { target: 'x' });
    expect(res.statusCode).toBe(200);
    const rules = (await get(admin.token)).json().rules as Array<{ target: string; enabled: boolean }>;
    expect(rules.filter((r) => r.target === 'x').every((r) => !r.enabled)).toBe(true);
    expect(rules.find((r) => r.target === 'linkedin_org')!.enabled).toBe(true);
    await disable(admin.token);
  });
});

describe('a person only, in this workspace only', () => {
  beforeAll(async () => {
    // "Viewer" is a grant role, not a membership role (ADR-0007/0018): it only bites on a database the plain member role cannot already reach.
    await setRestricted(app, admin.token, wsId, 'database', postsDb);
  });

  it('a guest with a viewer grant, a member with no access, and a viewer grant cannot turn it on or pause it', async () => {
    const x = await connection('x');
    const other = await joinAs(app, admin.token, wsId, 'Publishing Bystander', 'member');
    const rulesBefore = (await rulesOn(postsDb)).length;
    // The viewer can see the database and is told 403; the guest cannot see it at all and is told 404 (no hint it exists).
    for (const [who, status] of [[guest, 404], [viewer, 403]] as const) {
      expect((await enable(who.token, { connection_id: x, target: 'x' })).statusCode, who.id).toBe(status);
      expect((await disable(who.token)).statusCode, who.id).toBe(status);
    }
    expect((await enable(other.token, { connection_id: x, target: 'x' })).statusCode).toBe(404);
    expect(await rulesOn(postsDb)).toHaveLength(rulesBefore);
  });

  it('the read tells a person who may not manage only that: no connections, rules, accounts, fields or draft', async () => {
    const res = await get(viewer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applicable: true, can_manage: false, can_skip_approval: false, rules: [], channels: [], fields: null, draft: null, state: 'not_set_up' });
    expect(JSON.stringify(res.json())).not.toContain('urn:li');
  });

  it('an agent token and an MCP token acting for an admin cannot turn publishing on; the same tokens may still pause it', async () => {
    const tokens = app.get(TokensService);
    const agent = (await tokens.create(adminId, wsId, `agent-${randomUUID()}`, 'admin', true, 'agent')).token;
    const mcp = (await tokens.create(adminId, wsId, `mcp-${randomUUID()}`, 'admin', true)).token;
    const x = await connection('x');
    const rulesBefore = (await rulesOn(postsDb)).length;
    for (const t of [agent, mcp]) {
      const res = await enable(t, { connection_id: x, target: 'x' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/needs a person/);
    }
    expect(await rulesOn(postsDb)).toHaveLength(rulesBefore);
    const stop = await disable(agent);
    expect(stop.statusCode).toBe(200);
  });

  it('a Runner run credential is refused by the route itself (@NoRunCredential on enable, so an agent run can never start it)', () => {
    const reflector = new Reflector();
    expect(reflector.get(NO_RUN_CREDENTIAL_KEY, PublishingController.prototype.enable)).toBe(true);
  });

  it('another workspace gets a 404 for all three calls, and a database of another workspace is not reachable through this one', async () => {
    const otherWs = (await as(outsider.token, 'GET', '/workspaces')).json()[0].id as string;
    expect((await get(outsider.token, postsDb, wsId)).statusCode).toBe(404);
    expect((await enable(outsider.token, { connection_id: randomUUID(), target: 'x' }, postsDb, wsId)).statusCode).toBe(404);
    expect((await disable(outsider.token, {}, postsDb, wsId)).statusCode).toBe(404);
    expect((await get(admin.token, postsDb, otherWs)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('input is rejected in the controller, not by a constraint: a bad target and a non-uuid connection are 422s', async () => {
    expect((await enable(admin.token, { connection_id: 'nope', target: 'x' })).statusCode).toBe(422);
    expect((await enable(admin.token, { connection_id: randomUUID(), target: 'facebook' })).statusCode).toBe(422);
    expect((await disable(admin.token, { target: 'facebook' })).statusCode).toBe(422);
  });
});
