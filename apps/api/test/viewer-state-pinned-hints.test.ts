import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { viewerState } from '../src/db/schema';

/**
 * ticket #986 — the REST half of two viewer_state kinds: `pinned_tabs` (for #966) and `dismissed_hints` (for #976). Both ride the same
 * registry and the same access check as `view_filter`; what is tested here is what is NEW: the routes, the read-time cleaning of pinned
 * views, who may pin which view, and that a dismissal is per person and per workspace.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string, tasks: string, other: string;
let v1: string, v2: string, v3: string, otherDbView: string;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const pinUrl = (db = tasks, w = ws) => `/workspaces/${w}/databases/${db}/pinned-tabs`;
const hintsUrl = (w = ws) => `/workspaces/${w}/dismissed-hints`;
const mkView = async (token: string, db: string, name: string, personal = false) => {
  const res = await as(token, 'POST', `/workspaces/${ws}/databases/${db}/views${personal ? '/personal' : ''}`, { name, type: 'table' });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Pin Owner');
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'Pin WS' })).json().id;
  space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  other = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Other' })).json().id;
  v1 = await mkView(owner.token, tasks, 'One');
  v2 = await mkView(owner.token, tasks, 'Two');
  v3 = await mkView(owner.token, tasks, 'Three');
  otherDbView = await mkView(owner.token, other, 'Elsewhere');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#986 pinned_tabs', () => {
  it('nothing pinned reads as an empty list; PUT then GET returns my order, and the order is mine to change', async () => {
    expect((await as(owner.token, 'GET', pinUrl())).json()).toEqual({ view_ids: [] });
    expect((await as(owner.token, 'PUT', pinUrl(), { view_ids: [v3, v1] })).json()).toEqual({ view_ids: [v3, v1] });
    expect((await as(owner.token, 'GET', pinUrl())).json()).toEqual({ view_ids: [v3, v1] });
    expect((await as(owner.token, 'PUT', pinUrl(), { view_ids: [v1, v2, v3] })).json().view_ids).toEqual([v1, v2, v3]);
    expect((await as(owner.token, 'DELETE', pinUrl())).json()).toEqual({ cleared: true });
    expect((await as(owner.token, 'GET', pinUrl())).json()).toEqual({ view_ids: [] });
  });

  it('rejects a duplicate (422), a view of ANOTHER database (404), a non-uuid (400/422), and more than 50 — and writes nothing', async () => {
    await as(owner.token, 'PUT', pinUrl(), { view_ids: [v1] });
    expect((await as(owner.token, 'PUT', pinUrl(), { view_ids: [v1, v1] })).statusCode).toBe(422);
    expect((await as(owner.token, 'PUT', pinUrl(), { view_ids: [otherDbView] })).statusCode).toBe(404);
    expect([400, 422]).toContain((await as(owner.token, 'PUT', pinUrl(), { view_ids: ['nope'] })).statusCode);
    expect([400, 422]).toContain((await as(owner.token, 'PUT', pinUrl(), { view_ids: Array.from({ length: 51 }, () => v1) })).statusCode);
    expect((await as(owner.token, 'GET', pinUrl())).json().view_ids, 'every refused write left the previous pins alone').toEqual([v1]);
  });

  it('a view trashed after it was pinned is left out on read, while the stored row is not rewritten; restoring it brings it back', async () => {
    await as(owner.token, 'PUT', pinUrl(), { view_ids: [v1, v2, v3] });
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/databases/${tasks}/views/${v2}`)).statusCode).toBe(200);
    expect((await as(owner.token, 'GET', pinUrl())).json().view_ids).toEqual([v1, v3]);
    const stored = await raw.select().from(viewerState).where(eq(viewerState.kind, 'pinned_tabs'));
    expect(JSON.stringify(stored.map((r) => r.data))).toContain(v2);
    expect((await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/views/${v2}/restore`)).statusCode).toBe(201);
    expect((await as(owner.token, 'GET', pinUrl())).json().view_ids).toEqual([v1, v2, v3]);
  });

  it("someone else's PERSONAL view cannot be pinned (and answers 'not found', never confirming it exists); my own can, and drops out if it stops being visible to me", async () => {
    const member = await joinAs(app, owner.token, ws, 'Pin Member', 'member');
    const mine = await mkView(member.token, tasks, 'Mine', true);
    const theirs = await mkView(owner.token, tasks, 'Owner private', true);
    expect((await as(member.token, 'PUT', pinUrl(), { view_ids: [theirs] })).statusCode).toBe(404);
    expect((await as(member.token, 'PUT', pinUrl(), { view_ids: [v1, mine] })).json().view_ids).toEqual([v1, mine]);
    // the owner of a personal view is the only one whose read keeps it
    expect((await as(owner.token, 'PUT', pinUrl(), { view_ids: [theirs, v1] })).json().view_ids).toEqual([theirs, v1]);
  });

  it('access is the database: a guest on ANOTHER database gets 404 on every verb and nothing is written; a viewer-only guest may pin shared views', async () => {
    const stranger = await joinAs(app, owner.token, ws, 'Pin Stranger', 'guest', [{ database_id: other, role: 'viewer' }]);
    for (const [method, body] of [['GET', undefined], ['PUT', { view_ids: [v1] }], ['DELETE', undefined]] as const) {
      const res = await as(stranger.token, method, pinUrl(), body);
      expect(res.statusCode, `${method}: ${res.body}`).toBe(404);
    }
    expect(await raw.select().from(viewerState).where(eq(viewerState.userId, stranger.id))).toHaveLength(0);
    const viewer = await joinAs(app, owner.token, ws, 'Pin Viewer', 'guest', [{ database_id: tasks, role: 'viewer' }]);
    expect((await as(viewer.token, 'PUT', pinUrl(), { view_ids: [v2, v1] })).json().view_ids).toEqual([v2, v1]);
    // pins are per person
    expect((await as(owner.token, 'GET', pinUrl())).json().view_ids).not.toEqual([v2, v1]);
  });

  it('a guest who LOSES the database sees 404, not their old pins', async () => {
    const g = await joinAs(app, owner.token, ws, 'Pin Leaver', 'guest', [{ database_id: tasks, role: 'viewer' }]);
    await as(g.token, 'PUT', pinUrl(), { view_ids: [v1] });
    const grants = (await as(owner.token, 'GET', `/workspaces/${ws}/grants?user_id=${g.id}`)).json().data as Array<{ id: string }>;
    expect(grants.length, 'the grant to revoke').toBeGreaterThan(0);
    for (const grant of grants) expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/grants/${grant.id}`)).statusCode).toBeLessThan(300);
    expect((await as(g.token, 'GET', pinUrl())).statusCode).toBe(404);
  });
});

describe('#986 dismissed_hints', () => {
  it('starts empty, round-trips, replaces (not appends), and clears', async () => {
    expect((await as(owner.token, 'GET', hintsUrl())).json()).toEqual({ hint_ids: [] });
    expect((await as(owner.token, 'PUT', hintsUrl(), { hint_ids: ['agent-runs-explainer'] })).json()).toEqual({ hint_ids: ['agent-runs-explainer'] });
    expect((await as(owner.token, 'PUT', hintsUrl(), { hint_ids: ['agent-runs-explainer', 'pinned-tabs.intro'] })).json().hint_ids).toHaveLength(2);
    expect((await as(owner.token, 'GET', hintsUrl())).json().hint_ids).toEqual(['agent-runs-explainer', 'pinned-tabs.intro']);
    expect((await as(owner.token, 'DELETE', hintsUrl())).json()).toEqual({ cleared: true });
    expect((await as(owner.token, 'GET', hintsUrl())).json()).toEqual({ hint_ids: [] });
  });

  it('refuses a duplicate hint, an empty or oversized id, an id with odd characters, and more than 200 — leaving the stored list alone', async () => {
    await as(owner.token, 'PUT', hintsUrl(), { hint_ids: ['keep'] });
    for (const hint_ids of [['a', 'a'], [''], ['x'.repeat(101)], ['has space'], ['<script>'], Array.from({ length: 201 }, (_, i) => `h${i}`)]) {
      expect([400, 422], JSON.stringify(hint_ids).slice(0, 40)).toContain((await as(owner.token, 'PUT', hintsUrl(), { hint_ids })).statusCode);
    }
    expect((await as(owner.token, 'GET', hintsUrl())).json().hint_ids).toEqual(['keep']);
  });

  it('is per person and per workspace: my dismissal never hides a card for a teammate, or in my other workspace', async () => {
    const mate = await joinAs(app, owner.token, ws, 'Hint Mate', 'member');
    await as(owner.token, 'PUT', hintsUrl(), { hint_ids: ['only-mine'] });
    expect((await as(mate.token, 'GET', hintsUrl())).json()).toEqual({ hint_ids: [] });
    const ws2 = (await as(owner.token, 'POST', '/workspaces', { name: 'Hint WS 2' })).json().id as string;
    expect((await as(owner.token, 'GET', hintsUrl(ws2))).json()).toEqual({ hint_ids: [] });
    expect((await as(mate.token, 'PUT', hintsUrl(), { hint_ids: ['theirs'] })).json().hint_ids).toEqual(['theirs']);
    expect((await as(owner.token, 'GET', hintsUrl())).json().hint_ids).toEqual(['only-mine']);
  });

  it('a person who is not a member of the workspace is refused, and nothing is written', async () => {
    const outsider = await signUpUser(app, 'Hint Outsider');
    for (const [method, body] of [['GET', undefined], ['PUT', { hint_ids: ['x'] }], ['DELETE', undefined]] as const) {
      const res = await as(outsider.token, method, hintsUrl(), body);
      expect([403, 404], `${method}: ${res.body}`).toContain(res.statusCode);
    }
    expect(await raw.select().from(viewerState).where(eq(viewerState.kind, 'dismissed_hints'))).not.toContainEqual(expect.objectContaining({ data: { hint_ids: ['x'] } }));
  });
});
