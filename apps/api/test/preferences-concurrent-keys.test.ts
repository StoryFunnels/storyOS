import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * ticket #981 — the preferences blob (`user_preferences.preferences`) was updated by read-modify-write of the WHOLE blob: read it, spread
 * the patch over it, write all of it back. Two PATCHes for two DIFFERENT keys (a notification toggle from one tab, a date format from
 * another) raced and the later write put back the blob it had read BEFORE the other landed, so one vanished — the same defect #973 fixed
 * for the per-view overrides. The write is now one atomic statement that merges each patched key into the stored value, so writes to
 * different keys cannot lose each other. Same measurement as #973: 100 rounds of parallel writes.
 */
let app: NestFastifyApplication;
let token: string;
let other: string;
const as = (t: string, method: string, url: string, payload?: unknown) => call(app, t, method, url, payload);
const patch = (t: string, body: unknown) => as(t, 'PATCH', '/users/me/preferences', body);
const read = async (t: string) => (await as(t, 'GET', '/users/me/preferences')).json();

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Prefs Concurrent')).token;
  other = (await signUpUser(app, 'Prefs Other')).token;
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#981 concurrent preference writes to different keys never lose each other', () => {
  it('six keys written in parallel, 100 rounds, every write survives', async () => {
    const DB = '11111111-1111-4111-8111-111111111111';
    const lost: string[] = [];
    for (let r = 0; r < 100; r++) {
      const on = r % 2 === 0;
      const results = await Promise.all([
        patch(token, { notifications: { mentioned: on } }),
        patch(token, { regional: { dateFormat: on ? 'DMY' : 'YMD' } }),
        patch(token, { github: { login: on ? `octo${r}` : null } }),
        patch(token, { myWork: { [DB]: { sorts_nulls: on ? 'first' : 'last' } } }),
        patch(token, { activation: { dismissedWorkspaces: [`ws-${r}`] } }),
        patch(token, { sidebar: { viewsOnlyWorkspaces: [`vo-${r}`] } }),
      ]);
      expect(results.map((x) => x.statusCode), `round ${r}`).toEqual([200, 200, 200, 200, 200, 200]);
      const p = await read(token);
      const wrong = [
        p.notifications.mentioned !== on && 'notifications',
        p.regional.dateFormat !== (on ? 'DMY' : 'YMD') && 'regional',
        p.github.login !== (on ? `octo${r}` : null) && 'github',
        p.myWork[DB]?.sorts_nulls !== (on ? 'first' : 'last') && 'myWork',
        p.activation.dismissedWorkspaces[0] !== `ws-${r}` && 'activation',
        p.sidebar.viewsOnlyWorkspaces[0] !== `vo-${r}` && 'sidebar',
      ].filter(Boolean) as string[];
      if (wrong.length) lost.push(`round ${r}: ${wrong.join(', ')}`);
    }
    expect(lost, `${lost.length} of 100 rounds lost a write:\n${lost.slice(0, 5).join('\n')}`).toEqual([]);
  }, 300_000);

  it('two keys inside the SAME group (two toggles) also survive, and a toggle never disturbs its siblings', async () => {
    let lost = 0;
    for (let r = 0; r < 50; r++) {
      const on = r % 2 === 0;
      await Promise.all([patch(other, { notifications: { assigned: on } }), patch(other, { notifications: { commented: !on } })]);
      const p = await read(other);
      if (p.notifications.assigned !== on || p.notifications.commented !== !on) lost++;
    }
    expect(lost).toBe(0);
  }, 300_000);

  it('the merge rules are unchanged: a patch to one group leaves the rest, defaults still apply, myWork replaces per database, an empty patch is a no-op', async () => {
    const fresh = (await signUpUser(app, 'Prefs Rules')).token;
    const before = await read(fresh);
    expect(before.notifications).toMatchObject({ assigned: true, mentioned: true });
    expect((await patch(fresh, {})).statusCode).toBe(200);
    expect(await read(fresh)).toEqual(before);
    await patch(fresh, { notifications: { mentioned: false } });
    const a = await read(fresh);
    expect(a.notifications).toEqual({ ...before.notifications, mentioned: false });
    expect(a.regional).toEqual(before.regional);
    const D1 = '22222222-2222-4222-8222-222222222222';
    const D2 = '33333333-3333-4333-8333-333333333333';
    await patch(fresh, { myWork: { [D1]: { sorts_nulls: 'first', hidden_field_ids: ['a'] } } });
    await patch(fresh, { myWork: { [D2]: { sorts_nulls: 'last' } } });
    await patch(fresh, { myWork: { [D1]: { sorts_nulls: 'last' } } }); // replaces D1's config, keeps D2
    const b = await read(fresh);
    expect(b.myWork[D1]).toEqual({ sorts_nulls: 'last' });
    expect(b.myWork[D2]).toEqual({ sorts_nulls: 'last' });
    const res = await patch(fresh, { github: { login: null } });
    expect(res.json().github.login).toBeNull(); // the response is the merged result, same shape as before
  });
});
