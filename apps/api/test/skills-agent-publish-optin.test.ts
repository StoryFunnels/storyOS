import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { skills, user, workspaces } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #848 — the agent-publish opt-in. ADR-0010 is NOT relaxed: an agent still never decides for a
 * human. A person decides ONCE, in advance, for the workspace, and only at `shared`.
 *
 * Adversarial where it counts: the opt-in is turned on through an `mcp` token and an agent-origin
 * token and the STORED value is read back, not just the status code; and the same admin identity
 * through a session is the positive control. After #858 an OAuth-connected AI is `mcp` exactly as
 * a PAT is (test/oauth-source.test.ts), so a token here stands for both.
 */
let app: NestFastifyApplication;
let db: Db;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let teammate: { token: string; email: string };
let wsA: string;
let wsB: string;
let patA: string;
let agentA: string;
let patB: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: 'd', when_to_use: 'w', instructions: `instructions of ${name}`, ...extra,
});
const flag = async (ws: string) =>
  ((await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws) }))!.settings as Record<string, unknown>)?.['agents_may_publish_skills'];
const setFlag = (value: boolean, ws = wsA) => call(admin.token, 'PATCH', `/workspaces/${ws}`, { agents_may_publish_skills: value });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  tokens = app.get(TokensService);
  admin = await signUpUser(app, 'OptIn Admin');
  teammate = await signUpUser(app, 'OptIn Teammate');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsA = (await call(admin.token, 'POST', '/workspaces', { name: 'optin A' })).json().id;
  wsB = (await call(admin.token, 'POST', '/workspaces', { name: 'optin B' })).json().id;
  const inv = await call(admin.token, 'POST', `/workspaces/${wsA}/invites`, { email: teammate.email, role: 'member' });
  await call(teammate.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  patA = (await tokens.create(adminId, wsA, 'pat-a', 'admin', true)).token; // ordinary PAT = mcp
  agentA = (await tokens.create(adminId, wsA, 'agent-a', 'admin', true, 'agent')).token;
  patB = (await tokens.create(adminId, wsB, 'pat-b', 'admin', true)).token;
});

afterAll(async () => {
  await app.close();
});

describe('#848 AC2 — settable ONLY from a human-sourced request (stored value asserted, not just the code)', () => {
  it('a token (mcp) and an agent-origin token are refused, with the reason, and the stored flag does not change', async () => {
    for (const [label, t] of [['mcp', patA], ['agent', agentA]] as const) {
      for (const value of [true, false]) {
        const res = await call(t, 'PATCH', `/workspaces/${wsA}`, { agents_may_publish_skills: value });
        expect(res.statusCode, `${label} ${value}: ${res.body}`).toBe(403);
        expect(res.json().error.message).toMatch(/decided by a person/);
        expect(await flag(wsA), `${label}: stored value unchanged`).toBeUndefined();
      }
    }
  });

  it('the SAME admin through a session can (positive control) and the value is stored; other settings still work for a token', async () => {
    const res = await setFlag(true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await flag(wsA)).toBe(true);
    // A token may still change settings that are not this one (the guard is on the key, not the route).
    const rename = await call(patA, 'PATCH', `/workspaces/${wsA}`, { name: 'optin A renamed' });
    expect(rename.statusCode, rename.body).toBe(200);
    expect(await flag(wsA), 'a token PATCH of another key did not clear it').toBe(true);
    await setFlag(false);
    expect(await flag(wsA)).toBe(false);
  });
});

describe('#848 AC1/AC8 — OFF (the default) is exactly #990: agents cannot publish', () => {
  it('omitted -> personal; shared, members, public -> 403 (regression guard for assertMayPublish)', async () => {
    expect(await flag(wsA)).toBe(false);
    const dflt = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('off default'));
    expect(dflt.statusCode, dflt.body).toBe(201);
    expect(dflt.json().visibility).toBe('personal');
    for (const visibility of ['shared', 'public']) {
      const res = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill(`off ${visibility}`, { visibility }));
      expect(res.statusCode, `${visibility}: ${res.body}`).toBe(403);
    }
    expect(JSON.stringify((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('off shared 2', { visibility: 'shared' }))).json())).toMatch(/Settings > General/);
  });
});

describe('#848 — ON: agents may publish to the workspace, at `shared` and nothing wider', () => {
  beforeAll(async () => {
    expect((await setFlag(true)).statusCode).toBe(200);
  });

  it('AC6: an omitted visibility follows a person\'s default (shared); explicit shared works; update personal -> shared works', async () => {
    const dflt = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('on default'));
    expect(dflt.statusCode, dflt.body).toBe(201);
    expect(dflt.json().visibility).toBe('shared');
    expect(dflt.json().source, 'still badged as written by an agent').toBe('mcp');
    const explicit = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('on explicit', { visibility: 'shared' }));
    expect(explicit.statusCode, explicit.body).toBe(201);
    const personal = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('on personal', { visibility: 'personal' }));
    expect(personal.json().visibility, 'an explicit personal is still honoured').toBe('personal');
    const promoted = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${personal.json().id}`, { visibility: 'shared' });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().visibility).toBe('shared');
  });

  it('AC4: NEVER public, never members - on create and on update, with the opt-in ON', async () => {
    for (const t of [patA, agentA]) {
      const pub = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill('on public', { visibility: 'public' }));
      expect(pub.statusCode, pub.body).toBe(403);
      const members = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill('on members', { visibility: 'members', member_ids: [adminId] }));
      expect(members.statusCode, members.body).toBe(403);
      const named = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill('on named', { visibility: 'shared', member_ids: [adminId] }));
      expect(named.statusCode, `naming people is a different publication: ${named.body}`).toBeLessThan(500);
      expect(named.statusCode).not.toBe(201);
    }
    const mine = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('to widen'));
    for (const visibility of ['public', 'members']) {
      const up = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${mine.json().id}`, { visibility });
      expect(up.statusCode, `update to ${visibility}: ${up.body}`).toBe(403);
    }
    const stored = await db.query.skills.findFirst({ where: eq(skills.id, mine.json().id) });
    expect(stored!.visibility, 'the stored row did not widen').toBe('shared');
    expect(stored!.publicToken, 'no public link was minted').toBeNull();
  });

  it('AC7 (API level): the admin\'s AI creates a skill with NO visibility; a teammate\'s separate session lists it and runs it', async () => {
    const made = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('Borderlands brief'));
    expect(made.statusCode, made.body).toBe(201);
    const list = await call(teammate.token, 'GET', `/workspaces/${wsA}/skills`);
    expect(list.json().data.map((s: { id: string }) => s.id), 'the teammate sees it').toContain(made.json().id);
    const got = await call(teammate.token, 'GET', `/workspaces/${wsA}/skills/${made.json().id}`);
    expect(got.json().instructions).toBe('instructions of Borderlands brief');
    const ran = await call(teammate.token, 'POST', `/workspaces/${wsA}/skills/${made.json().id}/run`);
    expect(ran.statusCode, ran.body).toBeLessThan(300);
  });

  it('AC5: per-workspace - workspace B, never opted in, is unaffected', async () => {
    const dflt = await call(patB, 'POST', `/workspaces/${wsB}/skills`, skill('b default'));
    expect(dflt.json().visibility).toBe('personal');
    const shared = await call(patB, 'POST', `/workspaces/${wsB}/skills`, skill('b shared', { visibility: 'shared' }));
    expect(shared.statusCode, shared.body).toBe(403);
  });

  it('turning it OFF applies to the very next request (nothing remembers it)', async () => {
    expect((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('still on', { visibility: 'shared' }))).statusCode).toBe(201);
    expect((await setFlag(false)).statusCode).toBe(200);
    const after = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('now off', { visibility: 'shared' }));
    expect(after.statusCode, after.body).toBe(403);
    expect((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('now off default'))).json().visibility).toBe('personal');
  });
});
