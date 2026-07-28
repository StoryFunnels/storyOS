import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { MembersDbService } from '../src/members/members-db.service';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';

let app: NestFastifyApplication;
let subscriber: MembersProjectionSubscriber;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

/** Await the workspace's projection chain so assertions see its effects. */
async function settle() {
  await subscriber.settle(wsId);
}

/** The Members system database for the workspace, by name, or undefined. */
async function membersDb(): Promise<{ id: string; name: string; spaceSlug?: string } | undefined> {
  const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json() as Array<{
    id: string;
    name: string;
  }>;
  return dbs.find((d) => d.name === 'Members');
}

/** All Member rows (records) in the Members database. */
async function memberRows(dbId: string): Promise<Array<{ id: string; title: string; values: Record<string, unknown> }>> {
  return (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json().data;
}

/** role select option id → label, read off the database detail. */
async function roleLabels(dbId: string): Promise<Map<string, string>> {
  const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  const role = detail.fields.find((f: { apiName: string }) => f.apiName === 'role');
  return new Map((role?.options ?? []).map((o: { id: string; label: string }) => [o.id, o.label]));
}

/** The Member row for an email (rows are keyed by user; email is the human handle). */
async function rowFor(dbId: string, email: string) {
  return (await memberRows(dbId)).find((r) => r.values['email'] === email);
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(MembersProjectionSubscriber);
  admin = await signUpUser(app, 'MembersAdmin');
  guest = await signUpUser(app, 'MembersGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Members WS' })).json().id;
  await settle(); // the owner's membership provisions the DB + admin row
});

afterAll(async () => {
  await app.close();
});

describe('Members system database (#128 Phase 1)', () => {
  it('provisions the Members database in the default space with the projection fields', async () => {
    const db = await membersDb();
    expect(db, 'Members database should be provisioned on workspace creation').toBeTruthy();

    // Lives in the workspace's existing default space (the "General" space
    // created with the workspace) — it does not add a top-level system space.
    const spaces = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{
      name: string;
    }>;
    expect(spaces.map((s) => s.name)).toEqual(['General']);

    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db!.id}`)).json();
    const byName = new Map<string, { type: string }>(
      detail.fields.map((f: { apiName: string; type: string }) => [f.apiName, f]),
    );
    for (const [name, type] of [
      ['email', 'email'],
      ['avatar', 'url'],
      ['role', 'select'],
      ['active', 'checkbox'],
      ['user_id', 'text'],
    ] as const) {
      expect(byName.get(name), `missing field ${name}`).toBeTruthy();
      expect(byName.get(name)!.type, `field ${name} type`).toBe(type);
    }
  });

  it('projects a row for the workspace owner — active, role admin, with email', async () => {
    const db = (await membersDb())!;
    const row = await rowFor(db.id, admin.email);
    expect(row, 'owner should have a Member row').toBeTruthy();
    expect(row!.title).toBe('MembersAdmin');
    expect(row!.values['active']).toBe(true);
    expect(row!.values['user_id']).toBeTruthy();
    const labels = await roleLabels(db.id);
    expect(labels.get(row!.values['role'] as string)).toBe('admin');
  });

  it('projects a joined guest — proving guests/external people are included', async () => {
    // Guest invites require at least one grant (ADR-0007). A `viewer` grant is
    // non-billable, so promoting the guest later stays within the Free cap.
    const spaces = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{
      id: string;
      name: string;
    }>;
    const general = spaces.find((s) => s.name === 'General')!;

    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: general.id, role: 'viewer' }],
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    const accept = await as(guest.token, 'POST', '/invites/accept', { token });
    expect(accept.statusCode, accept.body).toBe(201);
    await settle();

    const db = (await membersDb())!;
    const row = await rowFor(db.id, guest.email);
    expect(row, 'guest should have a Member row').toBeTruthy();
    expect(row!.values['active']).toBe(true);
    const labels = await roleLabels(db.id);
    expect(labels.get(row!.values['role'] as string)).toBe('guest');
  });

  it('backfillWorkspace is idempotent — no duplicate database, no duplicate rows', async () => {
    const db = (await membersDb())!;
    const before = await memberRows(db.id);

    const service = app.get(MembersDbService);
    await service.backfillWorkspace(wsId);
    await service.backfillWorkspace(wsId);

    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json() as Array<{ name: string }>;
    expect(dbs.filter((d) => d.name === 'Members')).toHaveLength(1);

    const after = await memberRows(db.id);
    expect(after).toHaveLength(before.length); // admin + guest, unchanged
  });

  it('reflects a role change into the Member row (guest → member)', async () => {
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { email: string };
    }>;
    const guestMembership = members.find((m) => m.user.email === guest.email)!;

    const patch = await as(admin.token, 'PATCH', `/workspaces/${wsId}/members/${guestMembership.id}`, {
      role: 'member',
    });
    expect(patch.statusCode, patch.body).toBe(200);
    await settle();

    const db = (await membersDb())!;
    const rowsForGuest = (await memberRows(db.id)).filter((r) => r.values['email'] === guest.email);
    expect(rowsForGuest, 'role change must not duplicate the row').toHaveLength(1);
    const labels = await roleLabels(db.id);
    expect(labels.get(rowsForGuest[0]!.values['role'] as string)).toBe('member');
    expect(rowsForGuest[0]!.values['active']).toBe(true);
  });

  it('tombstones (does NOT delete) the row when a membership is removed', async () => {
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { email: string };
    }>;
    const guestMembership = members.find((m) => m.user.email === guest.email)!;

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${guestMembership.id}`);
    expect(del.statusCode, del.body).toBe(200);
    await settle();

    const db = (await membersDb())!;
    const row = await rowFor(db.id, guest.email);
    expect(row, 'removed member row must survive as a tombstone').toBeTruthy();
    expect(row!.values['active']).toBe(false);
  });
});
