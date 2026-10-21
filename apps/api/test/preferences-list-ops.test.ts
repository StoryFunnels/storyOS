import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * ticket #987 — `activation.dismissedWorkspaces` and `sidebar.viewsOnlyWorkspaces` are lists, and the client wrote them by sending the
 * whole next list. Ticket #981 made writes to different KEYS atomic, but two tabs each adding a different workspace to the SAME list still
 * lost one: each sent "the list I last saw, plus mine". `PATCH /users/me/preferences/lists` adds and removes items atomically instead.
 */
let app: NestFastifyApplication;
let token: string;
const as = (t: string, method: string, url: string, payload?: unknown) => call(app, t, method, url, payload);
const edit = (t: string, body: unknown) => as(t, 'PATCH', '/users/me/preferences/lists', body);
const prefs = async (t: string) => (await as(t, 'GET', '/users/me/preferences')).json();

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'List Ops')).token;
}, 240_000);
afterAll(async () => { await app.close(); });

const LISTS = [
  { list: 'dismissed_workspaces', read: (p: { activation: { dismissedWorkspaces: string[] } }) => p.activation.dismissedWorkspaces },
  { list: 'views_only_workspaces', read: (p: { sidebar: { viewsOnlyWorkspaces: string[] } }) => p.sidebar.viewsOnlyWorkspaces },
] as const;

describe('#987 list-valued preferences are edited by add / remove, atomically', () => {
  for (const { list, read } of LISTS) {
    it(`${list}: two parallel adds of DIFFERENT items lose nothing, 100 rounds`, async () => {
      const t = (await signUpUser(app, `List ${list}`)).token;
      let lost = 0;
      for (let r = 0; r < 100; r++) {
        const [a, b] = await Promise.all([edit(t, { list, add: [`a${r}`] }), edit(t, { list, add: [`b${r}`] })]);
        expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
        const items = (read as (p: unknown) => string[])(await prefs(t));
        if (!items.includes(`a${r}`) || !items.includes(`b${r}`)) lost++;
      }
      expect(lost, `${lost} of 100 rounds lost an item`).toBe(0);
      expect((read as (p: unknown) => string[])(await prefs(t))).toHaveLength(200);
    }, 300_000);

    it(`${list}: an add racing a remove of a different item loses neither`, async () => {
      const t = (await signUpUser(app, `List mix ${list}`)).token;
      await edit(t, { list, add: Array.from({ length: 50 }, (_, i) => `old${i}`) });
      for (let r = 0; r < 50; r++) {
        await Promise.all([edit(t, { list, add: [`new${r}`] }), edit(t, { list, remove: [`old${r}`] })]);
      }
      const items = (read as (p: unknown) => string[])(await prefs(t));
      expect(items.filter((x) => x.startsWith('new'))).toHaveLength(50);
      expect(items.filter((x) => x.startsWith('old'))).toHaveLength(0);
    }, 300_000);
  }

  it('semantics: order kept, adding twice is a no-op, removing something absent is a no-op, remove wins over add, other prefs untouched', async () => {
    const t = (await signUpUser(app, 'List semantics')).token;
    await as(t, 'PATCH', '/users/me/preferences', { notifications: { mentioned: false } });
    const list = 'dismissed_workspaces';
    expect((await edit(t, { list, add: ['w1', 'w2', 'w1'] })).json().activation.dismissedWorkspaces).toEqual(['w1', 'w2']);
    expect((await edit(t, { list, add: ['w2', 'w3'] })).json().activation.dismissedWorkspaces).toEqual(['w1', 'w2', 'w3']);
    expect((await edit(t, { list, remove: ['nope'] })).json().activation.dismissedWorkspaces).toEqual(['w1', 'w2', 'w3']);
    expect((await edit(t, { list, remove: ['w2'] })).json().activation.dismissedWorkspaces).toEqual(['w1', 'w3']);
    expect((await edit(t, { list, add: ['w9'], remove: ['w9', 'w1'] })).json().activation.dismissedWorkspaces).toEqual(['w3']);
    const p = await prefs(t);
    expect(p.notifications.mentioned, 'an unrelated preference is untouched').toBe(false);
    expect(p.sidebar.viewsOnlyWorkspaces, 'the other list is untouched').toEqual([]);
  });

  it('a first-ever write for a user creates their preferences row', async () => {
    const t = (await signUpUser(app, 'List fresh')).token;
    expect((await edit(t, { list: 'views_only_workspaces', add: ['x'] })).json().sidebar.viewsOnlyWorkspaces).toEqual(['x']);
  });

  it('it coexists with the whole-list PATCH: a replace sets the list, a later add extends it', async () => {
    const t = (await signUpUser(app, 'List coexist')).token;
    await as(t, 'PATCH', '/users/me/preferences', { activation: { dismissedWorkspaces: ['a', 'b'] } });
    expect((await edit(t, { list: 'dismissed_workspaces', add: ['c'] })).json().activation.dismissedWorkspaces).toEqual(['a', 'b', 'c']);
  });

  it('keeps the NEWEST items when a list would pass 1000: the oldest are dropped, never the ones just added', async () => {
    const t = (await signUpUser(app, 'List cap')).token;
    const list = 'dismissed_workspaces';
    await edit(t, { list, add: Array.from({ length: 1000 }, (_, i) => `i${i}`) });
    const after = (await edit(t, { list, add: ['fresh'] })).json().activation.dismissedWorkspaces as string[];
    expect(after).toHaveLength(1000);
    expect(after[999]).toBe('fresh');
    expect(after).not.toContain('i0');
  });

  it('refuses nothing-to-do, an unknown list, an empty id and an over-long request (422/400), and writes nothing', async () => {
    const t = (await signUpUser(app, 'List refuse')).token;
    for (const body of [{ list: 'dismissed_workspaces' }, { list: 'dismissed_workspaces', add: [] }, { list: 'notifications', add: ['x'] }, { list: 'dismissed_workspaces', add: [''] }, { list: 'dismissed_workspaces', add: Array.from({ length: 1001 }, (_, i) => `x${i}`) }]) {
      expect([400, 422], JSON.stringify(body).slice(0, 60)).toContain((await edit(t, body)).statusCode);
    }
    expect((await prefs(t)).activation.dismissedWorkspaces).toEqual([]);
  });

  it('needs a signed-in user, and only ever edits the caller\'s own preferences', async () => {
    expect((await as('', 'PATCH', '/users/me/preferences/lists', { list: 'dismissed_workspaces', add: ['x'] }).catch(() => ({ statusCode: 401 }))).statusCode).toBe(401);
    const a = (await signUpUser(app, 'List A')).token;
    const b = (await signUpUser(app, 'List B')).token;
    await edit(a, { list: 'dismissed_workspaces', add: ['mine'] });
    expect((await prefs(b)).activation.dismissedWorkspaces).toEqual([]);
  });
});
