import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted, type Person } from './helpers/members';

/**
 * Ticket #1211 — a search result for a SPACE now opens that space (the palette used to send every one to the workspace home),
 * so the spaces search returns must be exactly the ones the caller can open: the sidebar DOOR (`visibleSpaceIds`, never
 * `assertSpace`) plus "never another member's personal space". Before, space results appeared only when every database was
 * visible, so a guest got none and an admin's search NAMED a colleague's personal space (private from admins, #291).
 *
 * A test without a GUEST fixture proves nothing here (CLAUDE.md): the guest holds a grant on ONE database, which is how a
 * space can be visible to someone who fails `assertSpace`.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: Person;
let alice: Person;
let guest: Person;
let ws: string;
let openSpace: string;
let closedSpace: string;
let grantedSpace: string;
let alicePersonalName: string;

const placeNames = async (token: string, q: string) =>
  ((await call(app, token, 'GET', `/workspaces/${ws}/search?q=${encodeURIComponent(q)}`)).json().places as Array<{ kind: string; name: string; id: string }>)
    .filter((p) => p.kind === 'space')
    .map((p) => p.name)
    .sort();

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SpaceDoorAdmin');
  ws = (await call(app, admin.token, 'POST', '/workspaces', { name: '1211 search door' })).json().id;
  const mk = async (name: string) => (await call(app, admin.token, 'POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
  openSpace = await mk('Orchid Open');
  closedSpace = await mk('Orchid Closed');
  grantedSpace = await mk('Orchid Granted');
  await setRestricted(app, admin.token, ws, 'space', closedSpace);
  const db = (await call(app, admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: grantedSpace, name: 'Granted tasks' })).json().id as string;

  member = await joinAs(app, admin.token, ws, 'SpaceDoorMember', 'member');
  alice = await joinAs(app, admin.token, ws, 'SpaceDoorAlice', 'member');
  guest = await joinAs(app, admin.token, ws, 'SpaceDoorGuest', 'guest', [{ database_id: db, role: 'viewer' }]);
  await grant(app, admin.token, ws, member.id, { space_id: grantedSpace }, 'viewer');

  const personal = (await call(app, alice.token, 'POST', `/workspaces/${ws}/spaces/personal`)).json();
  alicePersonalName = personal.name as string;
});

afterAll(async () => {
  await app.close();
});

describe('ticket #1211 — space results are the spaces the caller can open', () => {
  it('an admin finds every shared space, the restricted one included', async () => {
    expect(await placeNames(admin.token, 'orchid')).toEqual(['Orchid Closed', 'Orchid Granted', 'Orchid Open']);
  });

  it('a member does not find the restricted space they hold no grant on', async () => {
    const names = await placeNames(member.token, 'orchid');
    expect(names).toEqual(['Orchid Granted', 'Orchid Open']);
    expect(names).not.toContain('Orchid Closed');
  });

  it('a GUEST with a database grant finds the space that holds it, and nothing else', async () => {
    // The space is the door the sidebar shows them even though they fail assertSpace; the other spaces are not theirs.
    expect(await placeNames(guest.token, 'orchid')).toEqual(['Orchid Granted']);
  });

  it("nobody's search, an admin's included, names another member's personal space; its owner finds it", async () => {
    expect(await placeNames(admin.token, alicePersonalName)).not.toContain(alicePersonalName);
    expect(await placeNames(member.token, alicePersonalName)).not.toContain(alicePersonalName);
    expect(await placeNames(alice.token, alicePersonalName)).toContain(alicePersonalName);
  });

  it('every space the search returns also passes the direct-open path (no result is a 404 waiting to happen)', async () => {
    for (const who of [admin, member, guest]) {
      const res = await call(app, who.token, 'GET', `/workspaces/${ws}/search?q=orchid`);
      for (const p of res.json().places.filter((x: { kind: string }) => x.kind === 'space')) {
        const open = await call(app, who.token, 'GET', `/workspaces/${ws}/spaces/${p.id}/folders`);
        expect(open.statusCode, `${who.email} opening ${p.name}`).toBe(200);
      }
    }
  });
});
