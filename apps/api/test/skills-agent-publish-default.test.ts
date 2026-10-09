import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { skills, user, workspaces } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';
import { SkillsService } from '../src/skills/skills.service';
import { SkillPublishGateService } from '../src/automations/skill-publish-gate.service';

/**
 * #867 (founder's ruling, ADR-0010 amendment) — agents may publish workspace-visible skills BY DEFAULT,
 * in every workspace. The #848 switch is INVERTED, not deleted: an admin can switch it OFF, only a
 * person can, and `members`/`public` stay human-only (the per-action approval for `public` via MCP is
 * AC3 and is deliberately NOT built here: it depends on #859's approval fix, and until it exists
 * `public` through a token is a 403).
 *
 * A token here stands for an OAuth-connected AI too: #858 made both `mcp` (test/oauth-source.test.ts).
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
  admin = await signUpUser(app, 'Default Admin');
  teammate = await signUpUser(app, 'Default Teammate');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsA = (await call(admin.token, 'POST', '/workspaces', { name: 'default A' })).json().id;
  wsB = (await call(admin.token, 'POST', '/workspaces', { name: 'default B' })).json().id;
  const inv = await call(admin.token, 'POST', `/workspaces/${wsA}/invites`, { email: teammate.email, role: 'member' });
  await call(teammate.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  patA = (await tokens.create(adminId, wsA, 'pat-a', 'admin', true)).token; // ordinary PAT = mcp
  agentA = (await tokens.create(adminId, wsA, 'agent-a', 'admin', true, 'agent')).token;
  patB = (await tokens.create(adminId, wsB, 'pat-b', 'admin', true)).token;
});

afterAll(async () => {
  await app.close();
});

describe('#867 AC1/AC2 — in a workspace NO setting was ever touched, an agent publishes to the workspace', () => {
  it('the setting is genuinely untouched (absent), then: omitted -> shared (source stays mcp); explicit shared ok; explicit personal honoured; promote ok', async () => {
    expect(await flag(wsA), 'no setting was ever written').toBeUndefined();
    for (const [label, t] of [['mcp', patA], ['agent', agentA]] as const) {
      const dflt = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill(`${label} default`));
      expect(dflt.statusCode, dflt.body).toBe(201);
      expect(dflt.json().visibility, `${label}: omitted resolves like a person's`).toBe('shared');
      expect(dflt.json().source, 'attribution stays: written by the agent, not a person').not.toBe('human');
      const explicit = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill(`${label} explicit`, { visibility: 'shared' }));
      expect(explicit.statusCode, explicit.body).toBe(201);
    }
    const personal = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('kept private', { visibility: 'personal' }));
    expect(personal.json().visibility, 'an explicit personal is still honoured').toBe('personal');
    const promoted = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${personal.json().id}`, { visibility: 'shared' });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().visibility).toBe('shared');
  });

  it("end to end at the API level: the admin's AI creates with NO visibility and NO setting; a teammate's separate session lists, reads and runs it", async () => {
    const made = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('Borderlands brief'));
    expect(made.statusCode, made.body).toBe(201);
    const list = await call(teammate.token, 'GET', `/workspaces/${wsA}/skills`);
    expect(list.json().data.map((s: { id: string }) => s.id)).toContain(made.json().id);
    const got = await call(teammate.token, 'GET', `/workspaces/${wsA}/skills/${made.json().id}`);
    expect(got.json().instructions).toBe('instructions of Borderlands brief');
    expect((await call(teammate.token, 'POST', `/workspaces/${wsA}/skills/${made.json().id}/run`)).statusCode).toBeLessThan(300);
  });
});

describe('#867 AC3 — `public` from a token is a PROPOSAL, never a silent success (full flow: skills-public-approval.test.ts)', () => {
  it('with the default ON: public changes nothing by itself: personal/unchanged, no link minted; naming people on a SHARED skill is still a 422', async () => {
    for (const t of [patA, agentA]) {
      const named = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill('shared but named', { visibility: 'shared', member_ids: [adminId] }));
      expect(named.statusCode, named.body).not.toBe(201);
      const pub = await call(t, 'POST', `/workspaces/${wsA}/skills`, skill('proposal only', { visibility: 'public' }));
      expect(pub.statusCode, pub.body).toBe(201);
      expect(pub.json().visibility).toBe('personal');
      const row = await db.query.skills.findFirst({ where: eq(skills.id, pub.json().id) });
      expect(row!.publicToken, 'no public link without a person').toBeNull();
    }
    const mine = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('to widen'));
    const toPublic = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${mine.json().id}`, { visibility: 'public' });
    expect(toPublic.statusCode, toPublic.body).toBe(200);
    const stored = await db.query.skills.findFirst({ where: eq(skills.id, mine.json().id) });
    expect(stored!.visibility, 'unchanged until a person approves').toBe('shared');
    expect(stored!.publicToken).toBeNull();
  });
});

describe('#868 — `members` is reachable by an AI, under the SAME switch as `shared`, with no approval of its own', () => {
  it('create, edit the SET (add and remove), absence for everyone not named, no access grants created', async () => {
    const third = await signUpUser(app, 'Default Third');
    const thirdId = (await db.query.user.findFirst({ where: eq(user.email, third.email) }))!.id;
    const inv = await call(admin.token, 'POST', `/workspaces/${wsA}/invites`, { email: third.email, role: 'member' });
    await call(third.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const teammateId = (await call(teammate.token, 'GET', '/me')).json().user?.id ?? (await call(teammate.token, 'GET', '/me')).json().id;
    const grantsBefore = (await call(admin.token, 'GET', `/workspaces/${wsA}/grants`)).json();

    const made = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('for two people', { visibility: 'members', member_ids: [teammateId] }));
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().visibility).toBe('members');
    const id = made.json().id as string;
    const sees = async (t: string) => ((await call(t, 'GET', `/workspaces/${wsA}/skills`)).json().data as Array<{ id: string }>).map((x) => x.id).includes(id);
    expect(await sees(teammate.token), 'the named member sees it').toBe(true);
    expect(await sees(third.token), 'a member who is NOT named sees nothing').toBe(false);
    expect((await call(third.token, 'GET', `/workspaces/${wsA}/skills/${id}`)).statusCode, 'and gets the same absence by id').toBe(404);
    expect((await call(teammate.token, 'POST', `/workspaces/${wsA}/skills/${id}/run`)).statusCode, 'the named member can run it').toBeLessThan(300);

    // Add a person (replace the set with the old + new), then remove one.
    const added = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${id}`, { member_ids: [teammateId, thirdId] });
    expect(added.statusCode, added.body).toBe(200);
    expect(await sees(third.token), 'added: now sees it').toBe(true);
    const removed = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${id}`, { member_ids: [thirdId] });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await sees(teammate.token), 'removed: absent again').toBe(false);
    expect(await sees(third.token)).toBe(true);

    // The skill's own member mechanism, NOT access grants (#833 AC4): the grants table is untouched.
    expect((await call(admin.token, 'GET', `/workspaces/${wsA}/grants`)).json()).toEqual(grantsBefore);
    // A non-member is refused with the reason, and the stored set did not change.
    const bad = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${id}`, { member_ids: ['not-a-member'] });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(await sees(third.token)).toBe(true);
  });

  it('with AI publishing switched OFF, `members` is refused exactly like `shared` (the same switch), and the reason says so', async () => {
    expect((await setFlag(false)).statusCode).toBe(200);
    try {
      const res = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('members off', { visibility: 'members', member_ids: [adminId] }));
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.message).toMatch(/switched off AI publishing/);
    } finally {
      await setFlag(true);
    }
  });
});

describe('#867 AC4/AC5 — the #848 switch is INVERTED: an admin can switch AI publishing OFF, and only a person can', () => {
  it('OFF returns exactly to what PR #1011 shipped: omitted -> personal, shared and public -> 403; ON again restores the default', async () => {
    expect((await setFlag(false)).statusCode).toBe(200);
    expect(await flag(wsA)).toBe(false);
    const dflt = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('off default'));
    expect(dflt.json().visibility).toBe('personal');
    const shared = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('off shared', { visibility: 'shared' }));
    expect(shared.statusCode, shared.body).toBe(403);
    expect(shared.json().error.message).toMatch(/switched off/);
    expect((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('off public', { visibility: 'public' }))).statusCode).toBe(403);
    expect((await setFlag(true)).statusCode).toBe(200);
    expect((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('on again'))).json().visibility).toBe('shared');
  });

  it('the refusal never tells an AI to do something that is ALSO refused: "share it with the workspace" only when that works', async () => {
    // Only `public` can be refused while AI publishing is ON, and only when the approval path is
    // not registered (fail closed): then sharing with the workspace really is the alternative.
    const svc = app.get(SkillsService);
    const gate = app.get(SkillPublishGateService);
    svc.registerPublicGate(null);
    try {
      const on = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('copy public on', { visibility: 'public' }));
      expect(on.statusCode).toBe(403);
      expect(on.json().error.message).toMatch(/Share it with the workspace instead/);
      // OFF: that alternative would be refused too, so it must not be offered.
      expect((await setFlag(false)).statusCode).toBe(200);
      for (const visibility of ['members', 'public']) {
        const off = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill(`copy ${visibility} off`, { visibility, member_ids: visibility === 'members' ? [adminId] : undefined }));
        expect(off.statusCode, off.body).toBe(403);
        expect(off.json().error.message, visibility).not.toMatch(/Share it with the workspace instead/);
        expect(off.json().error.message, visibility).toMatch(/switched off AI publishing/);
      }
    } finally {
      svc.registerPublicGate(gate);
      await setFlag(true);
    }
  });

  it('AC5 adversarial, stored value read back: a token cannot turn it back ON after an admin turned it OFF (nor OFF in a default workspace)', async () => {
    expect((await setFlag(false)).statusCode).toBe(200);
    for (const t of [patA, agentA]) {
      const res = await call(t, 'PATCH', `/workspaces/${wsA}`, { agents_may_publish_skills: true });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.message).toMatch(/decided by a person/);
      expect(await flag(wsA), 'an agent cannot flip it back on').toBe(false);
    }
    const untouched = await call(patB, 'PATCH', `/workspaces/${wsB}`, { agents_may_publish_skills: false });
    expect(untouched.statusCode, untouched.body).toBe(403);
    expect(await flag(wsB), 'nor can it switch it off in a workspace that never touched it').toBeUndefined();
    expect((await setFlag(true)).statusCode).toBe(200);
  });

  it('AC7: per-workspace - switching it off in A does not affect B', async () => {
    expect((await setFlag(false, wsA)).statusCode).toBe(200);
    expect((await call(patB, 'POST', `/workspaces/${wsB}/skills`, skill('b default'))).json().visibility).toBe('shared');
    expect((await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('a default'))).json().visibility).toBe('personal');
    expect((await setFlag(true, wsA)).statusCode).toBe(200);
  });
});

describe('#867 AC8 — NO retroactive change: skills created under the old default stay personal', () => {
  it('a skill created personal (while AI publishing was off) is not widened by switching it back on; its owner promotes it themselves', async () => {
    expect((await setFlag(false)).statusCode).toBe(200);
    const old = await call(patA, 'POST', `/workspaces/${wsA}/skills`, skill('created under the old default'));
    expect(old.json().visibility).toBe('personal');
    expect((await setFlag(true)).statusCode).toBe(200);
    const stored = await db.query.skills.findFirst({ where: eq(skills.id, old.json().id) });
    expect(stored!.visibility, 'flipping the switch widened nothing').toBe('personal');
    const list = await call(teammate.token, 'GET', `/workspaces/${wsA}/skills`);
    expect(list.json().data.map((s: { id: string }) => s.id)).not.toContain(old.json().id);
    const promoted = await call(patA, 'PATCH', `/workspaces/${wsA}/skills/${old.json().id}`, { visibility: 'shared' });
    expect(promoted.statusCode, 'the owner can promote it through a token (MCP) exactly like any shared publish').toBe(200);
  });
});
