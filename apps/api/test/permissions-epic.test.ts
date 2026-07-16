import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * The Permissions & Access epic, on the ladder MN-121 landed:
 *   MN-124 delete is scoped to the specific space/database
 *   MN-123 favorites stop leaking titles across grant boundaries
 *   MN-125 grants upsert atomically, and revoke actually revokes
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let clientSpace: string;
let secretSpace: string;
let clientDb: string;
let secretDb: string;
let secretRec: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { space_id?: string; database_id?: string }, role: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...scope, role });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Boss');
  member = await signUpUser(app, 'Staff');
  guest = await signUpUser(app, 'Client');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Perms WS' })).json().id;
  secretSpace = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  clientSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Client Work' })).json().id;
  clientDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Client Tasks' })).json().id;
  secretDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: secretSpace, name: 'Acquisition Plans' })).json().id;
  secretRec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${secretDb}/records`, { values: { name: 'Project Falcon — buy NewCo' } })).json().id;

  for (const [who, role] of [[member, 'member'], [guest, 'guest']] as const) {
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: who.email,
      role,
      ...(role === 'guest' ? { grants: [{ space_id: clientSpace, role: 'creator' }] } : {}),
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(who.token, 'POST', '/invites/accept', { token });
  }
});

afterAll(async () => {
  await app.close();
});

describe('MN-123 — favorites must not leak titles', () => {
  it('a guest cannot star a record they cannot read', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/favorites`, {
      target_type: 'record',
      target_id: secretRec,
    });
    expect(res.statusCode, 'starring an unreadable id must be refused').toBe(404);
  });

  it('a guest cannot star a database they cannot read', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/favorites`, {
      target_type: 'database',
      target_id: secretDb,
    });
    expect(res.statusCode).toBe(404);
  });

  it('the title never comes back, even if a row already exists', async () => {
    // Simulate the pre-fix state: the row is there, list must still filter it.
    await as(admin.token, 'POST', `/workspaces/${wsId}/favorites`, { target_type: 'record', target_id: secretRec });
    const mine = (await as(guest.token, 'GET', `/workspaces/${wsId}/favorites`)).json();
    const titles = JSON.stringify(mine);
    expect(titles).not.toMatch(/Falcon/);
    expect(titles).not.toMatch(/Acquisition/);
  });

  it('a guest CAN star what they were granted', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientDb}/records`, { values: { name: 'Shared task' } })).json();
    expect((await as(guest.token, 'POST', `/workspaces/${wsId}/favorites`, { target_type: 'record', target_id: rec.id })).statusCode).toBe(201);
    const mine = (await as(guest.token, 'GET', `/workspaces/${wsId}/favorites`)).json();
    expect(JSON.stringify(mine)).toMatch(/Shared task/);
  });

  it('the admin still sees their own favorite', async () => {
    const mine = (await as(admin.token, 'GET', `/workspaces/${wsId}/favorites`)).json();
    expect(JSON.stringify(mine)).toMatch(/Falcon/);
  });
});

describe('MN-124 — delete is scoped to the thing being deleted', () => {
  it('a guest with creator on the client space CAN delete a database in it', async () => {
    const doomed = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Scratch' })).json();
    const res = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${doomed.id}`, { confirm: 'Scratch' });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('a guest CANNOT delete a database they have no grant on', async () => {
    const res = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${secretDb}`, {
      confirm: 'Acquisition Plans',
    });
    expect(res.statusCode, 'must 404 — not even confirm it exists').toBe(404);
  });

  it('a guest CANNOT delete a space they have no grant on', async () => {
    const res = await as(guest.token, 'DELETE', `/workspaces/${wsId}/spaces/${secretSpace}`);
    expect(res.statusCode).toBe(404);
  });

  it('a viewer-grant guest cannot delete the database they can read', async () => {
    await setGrant({ space_id: clientSpace }, 'viewer');
    const doomed = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Fragile' })).json();
    const res = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${doomed.id}`, { confirm: 'Fragile' });
    expect(res.statusCode, 'reading is not destroying').toBe(403);
    await setGrant({ space_id: clientSpace }, 'creator');
  });

  it('members keep workspace-wide delete — a recorded decision, not an oversight', async () => {
    const doomed = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: secretSpace, name: 'Members Can' })).json();
    const res = await as(member.token, 'DELETE', `/workspaces/${wsId}/databases/${doomed.id}`, { confirm: 'Members Can' });
    expect(res.statusCode, 'ADR-0009: members stay workspace-wide creators').toBeLessThan(300);
  });

  it('the typed-name confirmation still applies', async () => {
    const doomed = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Needs Confirm' })).json();
    const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${doomed.id}`, { confirm: 'wrong name' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('MN-125 — grants upsert atomically and revoke actually revokes', () => {
  it('concurrent grants on the same scope produce ONE row, not duplicates', async () => {
    const results = await Promise.all([
      setGrant({ database_id: clientDb }, 'viewer'),
      setGrant({ database_id: clientDb }, 'editor'),
      setGrant({ database_id: clientDb }, 'commenter'),
    ]);
    expect(results.every((r) => r.statusCode < 300), JSON.stringify(results.map((r) => r.statusCode))).toBe(true);

    const grants = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json();
    const list = Array.isArray(grants) ? grants : grants.data;
    const onDb = list.filter((g: { database_id?: string; databaseId?: string; user_id?: string; userId?: string }) =>
      (g.database_id ?? g.databaseId) === clientDb && (g.user_id ?? g.userId) === guestId,
    );
    expect(onDb, 'the unique index must collapse these to one row').toHaveLength(1);
  });

  it('revoking removes access for real — the dangerous half of the bug', async () => {
    const grants = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json();
    const list = Array.isArray(grants) ? grants : grants.data;
    const target = list.find((g: { database_id?: string; databaseId?: string }) => (g.database_id ?? g.databaseId) === clientDb);
    const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${target.id}`);
    expect(res.statusCode).toBeLessThan(300);

    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json();
    const afterList = Array.isArray(after) ? after : after.data;
    expect(
      afterList.filter((g: { database_id?: string; databaseId?: string }) => (g.database_id ?? g.databaseId) === clientDb),
      'a "successful" revoke that leaves a row behind leaves access behind',
    ).toHaveLength(0);
  });

  it('refuses a grant naming both scopes, and one naming neither', async () => {
    const both = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, {
      user_id: guestId, space_id: clientSpace, database_id: clientDb, role: 'viewer',
    });
    const neither = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, role: 'viewer' });
    expect(both.statusCode).toBeGreaterThanOrEqual(400);
    expect(neither.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('re-granting the same scope updates the role in place', async () => {
    await setGrant({ database_id: clientDb }, 'viewer');
    await setGrant({ database_id: clientDb }, 'creator');
    const grants = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json();
    const list = Array.isArray(grants) ? grants : grants.data;
    const onDb = list.filter((g: { database_id?: string; databaseId?: string }) => (g.database_id ?? g.databaseId) === clientDb);
    expect(onDb).toHaveLength(1);
    expect(onDb[0].role).toBe('creator');
  });
});
