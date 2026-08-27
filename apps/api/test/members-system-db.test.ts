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

/**
 * #418 / #419 — the projection has to hear about changes that do not go through
 * MembersService.
 *
 * Both defects were found by reading ADR-0017 against the code rather than from a
 * report, and both have the same shape: the Members projection updates only when
 * something emits a membership event, and two paths that change what it holds
 * emitted nothing.
 */
describe('#418 GDPR erasure reaches the Members projection', () => {
  it('wipes the name, email and avatar — and shows them present BEFORE', async () => {
    /*
     * The AC insists on before-and-after, and the reason is sharp: a test that
     * only asserts the after-state passes just as happily against a projection
     * that never ran at all.
     */
    const victim = await signUpUser(app, 'ToBeErased');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: victim.email,
      role: 'member',
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(victim.token, 'POST', '/invites/accept', { token });
    await settle();

    const dbId = (await membersDb())!.id;
    const before = await rowFor(dbId, victim.email);
    // BEFORE: the real identity is in the database.
    expect(before, 'the member row should exist before the erasure').toBeTruthy();
    expect(before!.values['email']).toBe(victim.email);
    expect(before!.values['active']).toBe(true);

    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { email: string };
    }>;
    const membershipId = members.find((m) => m.user.email === victim.email)!.id;
    const anon = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${membershipId}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBeLessThan(300);
    await settle();

    const rows = await memberRows(dbId);
    // AFTER: the real email is nowhere in the database.
    expect(rows.some((r) => r.values['email'] === victim.email)).toBe(false);

    const erased = rows.find((r) => String(r.values['email'] ?? '').includes('@anonymized.invalid'));
    expect(erased, 'the row must SURVIVE — deleting it would orphan every assignment').toBeTruthy();
    // `name` is the TITLE field on this database (members-db.service.ts:167), so
    // it lives on `records.title` and never appears in the values bag.
    expect(erased!.title).toBe('Deleted user');
    expect(erased!.values['avatar']).toBeFalsy();
    // Tombstoned too, in the workspace the erasure was requested in.
    expect(erased!.values['active']).toBe(false);
    // The projection key is kept on purpose: it is an opaque id whose account no
    // longer exists, and dropping it would leave an unreachable orphan row.
    expect(erased!.values['user_id']).toBeTruthy();
  });
});

describe('#419 a profile change reaches the Members projection', () => {
  it('an avatar change refreshes the row', async () => {
    const dbId = (await membersDb())!.id;
    const before = await rowFor(dbId, admin.email);
    expect(before!.values['avatar']).toBeFalsy();

    const BOUNDARY = 'X-AVATAR-BOUNDARY';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: { ...authed(admin.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="a.png"\r\ncontent-type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    /*
     * Asserted from the POST's own response, not from `/me`: that endpoint reads
     * `req.user`, which is the SESSION snapshot, so it reports the avatar the
     * session was created with rather than the one just written. Cost a
     * confusing failure before I checked.
     */
    expect((res.json() as { image?: string }).image, 'the avatar write must have landed').toBeTruthy();
    await settle();

    /*
     * Before this fix the row kept whatever it had until the person's next ROLE
     * change or the next API restart — both unrelated to the edit, which made the
     * fix time effectively random.
     */
    const after = await rowFor(dbId, admin.email);
    expect(after!.values['avatar']).toBeTruthy();
  });
});
