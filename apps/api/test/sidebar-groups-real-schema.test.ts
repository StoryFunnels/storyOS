/**
 * #742 S2 — retarget onto the REAL schema (#892's `space_groups` table +
 * `spaces.group_id`), per Otto's ruling that the deploy gate is not
 * satisfied until this exists: `sidebar-groups-presentational.test.ts`
 * (merged, #891) guards `workspaces.settings`, but Iris confirmed directly
 * that #892 "isn't touched by this PR at all" — the real implementation
 * persists grouping in `space_groups`/`spaces.groupId` instead. A fixture
 * guarding a storage location nothing reads proves nothing about what
 * shipped; this file proves the same three claims against the table that
 * actually exists on main now:
 *
 *   1. A guest scoped to one grouped space sees only that space — grouping
 *      with OTHER spaces never widens them past their real grant.
 *   2. The same holds in reverse — a guest scoped to a DIFFERENT space in
 *      the same group sees only THAT one, never the others (both directions
 *      matter: a grouping that could only ever restrict would still be an
 *      access boundary).
 *   3. An admin/member is unaffected either way (grouping never narrows
 *      unscoped access).
 *   4. The direct-open path (`GET .../databases/:db` → `effectiveForDatabase`)
 *      is covered too, not just the sidebar list — the exact gap Vera found
 *      in the settings-based version.
 *
 * The `workspaces.settings`-based assertions in the merged file are kept —
 * they still guard a FUTURE implementation that might persist grouping
 * there instead. This file is the one that's actually load-bearing today.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceA: string;
let spaceB: string;
let spaceC: string;
let dbInA: string;
let dbInB: string;
let groupId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function inviteAndAcceptGuest(name: string, grants: Array<{ space_id: string; role: string }>) {
  const guest = await signUpUser(app, name);
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: guest.email, role: 'guest', grants });
  expect(invite.statusCode, invite.body).toBe(201);
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accept = await as(guest.token, 'POST', '/invites/accept', { token });
  expect(accept.statusCode, accept.body).toBe(201);
  return guest;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RealGroupsOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '742 S2 Real Schema WS' })).json().id;

  async function makeSpace(name: string) {
    return (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name })).json().id;
  }
  async function makeDb(spaceId: string, name: string) {
    return (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
  }

  spaceA = await makeSpace('Real Space A');
  spaceB = await makeSpace('Real Space B');
  spaceC = await makeSpace('Real Space C');
  dbInA = await makeDb(spaceA, 'DB in A');
  dbInB = await makeDb(spaceB, 'DB in B');

  // The real grouping mechanism, end-to-end through its own real API —
  // create a group, then assign all three spaces to it via the same
  // space-update endpoint any sidebar drag-and-drop uses.
  const group = await as(admin.token, 'POST', `/workspaces/${wsId}/space-groups`, { name: 'Everything' });
  expect(group.statusCode, group.body).toBe(201);
  groupId = group.json().id;

  for (const spaceId of [spaceA, spaceB, spaceC]) {
    const patch = await as(admin.token, 'PATCH', `/workspaces/${wsId}/spaces/${spaceId}`, { groupId });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().groupId).toBe(groupId);
  }
});

afterAll(async () => {
  await app.close();
});

describe('#742 S2 (real schema) — space_groups/spaces.groupId confers no access', () => {
  it('a guest scoped to Space A sees only A — grouping with B/C never widens it', async () => {
    const guest = await inviteAndAcceptGuest('RealGuestA', [{ space_id: spaceA, role: 'viewer' }]);

    const spacesRes = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spacesRes.json().map((s: { id: string }) => s.id)).toEqual([spaceA]);

    const dbsRes = await as(guest.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(dbsRes.json().map((d: { id: string }) => d.id)).toEqual([dbInA]);
  });

  it('REVERSE: a guest scoped to Space B (same group) sees only B — never A or C', async () => {
    const guest = await inviteAndAcceptGuest('RealGuestB', [{ space_id: spaceB, role: 'viewer' }]);

    const spacesRes = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spacesRes.json().map((s: { id: string }) => s.id)).toEqual([spaceB]);

    const dbsRes = await as(guest.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(dbsRes.json().map((d: { id: string }) => d.id)).toEqual([dbInB]);
  });

  it('an admin/member is unaffected either way — grouping never restricts full access', async () => {
    const spacesRes = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`);
    const ids = spacesRes.json().map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([spaceA, spaceB, spaceC]));
  });

  it('DIRECT-OPEN: a guest scoped to A still gets 404 opening B\'s database directly, group membership notwithstanding', async () => {
    const guest = await inviteAndAcceptGuest('RealGuestDirect', [{ space_id: spaceA, role: 'viewer' }]);

    const direct = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbInB}`);
    expect(direct.statusCode, 'group_id must never make effectiveForDatabase resolve an ungranted database').toBe(404);

    const ownDirect = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbInA}`);
    expect(ownDirect.statusCode).toBe(200);
  });

  it('MUST KEEP WORKING: deleting the group falls every space back to ungrouped, with no access change', async () => {
    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/space-groups/${groupId}`);
    expect(del.statusCode, del.body).toBe(200);

    const spaceRow = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`);
    const found = spaceRow.json().find((s: { id: string }) => s.id === spaceA);
    expect(found.groupId).toBeNull();

    // Access is unaffected by the group's deletion — same guest, same one space.
    const guest = await inviteAndAcceptGuest('RealGuestAfterDelete', [{ space_id: spaceA, role: 'viewer' }]);
    const spacesRes = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spacesRes.json().map((s: { id: string }) => s.id)).toEqual([spaceA]);
  });
});
