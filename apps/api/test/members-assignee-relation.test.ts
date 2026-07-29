import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { MembersDbService } from '../src/members/members-db.service';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';

/**
 * Members system database — Phase 2 (#128): `assignee` (a `user`-typed field
 * holding a better-auth user id) resolves to its Members-database row, so
 * `assignee → member.name/email/avatar` is traversable. This is ADDITIVE and
 * back-compatible: the `user` field is stored, written, filtered and sorted
 * exactly as before; resolution is a read seam on top, and a backfill closes
 * the gap for existing assignee data that points at a user with no row.
 */
let app: NestFastifyApplication;
let subscriber: MembersProjectionSubscriber;
let membersService: MembersDbService;

let owner: { token: string; email: string };
let alice: { token: string; email: string };
let carol: { token: string; email: string };
let ownerId: string;
let aliceId: string;
let carolId: string;

let wsId: string;
let generalSpaceId: string;
let tasksDb: string;
let assigneeApi: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function settle() {
  await subscriber.settle(wsId);
}

/** The Members system database for the workspace. */
async function membersDbId(): Promise<string> {
  const dbs = (await as(owner.token, 'GET', `/workspaces/${wsId}/databases`)).json() as Array<{ id: string; name: string }>;
  return dbs.find((d) => d.name === 'Members')!.id;
}

/** Member rows keyed by user_id. */
async function memberRows(): Promise<Array<{ id: string; title: string; values: Record<string, unknown> }>> {
  const dbId = await membersDbId();
  return (await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json().data;
}

/** Invite `user` as a guest (non-billable, stays within the Free cap) and accept. */
async function joinAsGuest(user: { token: string; email: string }) {
  const invite = await as(owner.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: user.email,
    role: 'guest',
    grants: [{ space_id: generalSpaceId, role: 'viewer' }],
  });
  expect(invite.statusCode, invite.body).toBe(201);
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accept = await as(user.token, 'POST', '/invites/accept', { token });
  expect(accept.statusCode, accept.body).toBe(201);
  await settle();
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(MembersProjectionSubscriber);
  membersService = app.get(MembersDbService);

  owner = await signUpUser(app, 'AssigneeOwner');
  alice = await signUpUser(app, 'AssigneeAlice');
  carol = await signUpUser(app, 'AssigneeCarol');
  ownerId = (await as(owner.token, 'GET', '/me')).json().id;
  aliceId = (await as(alice.token, 'GET', '/me')).json().id;
  carolId = (await as(carol.token, 'GET', '/me')).json().id;

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Assignee WS' })).json().id;
  await settle(); // owner membership provisions the Members DB + owner row
  generalSpaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  await joinAsGuest(alice);
  await joinAsGuest(carol);

  tasksDb = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: generalSpaceId, name: 'Tasks' })
  ).json().id;
  assigneeApi = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, {
      display_name: 'Assignee',
      type: 'user',
    })
  ).json().apiName;

  // Existing assignee data: one task each for owner and alice.
  await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
    values: { name: 'Owner task', [assigneeApi]: ownerId },
  });
  await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
    values: { name: 'Alice task', [assigneeApi]: aliceId },
  });
});

afterAll(async () => {
  await app.close();
});

describe('assignee → Members resolution (#128 Phase 2)', () => {
  it('resolves an existing assignee value to the right Members row, with name/email/avatar', async () => {
    const resolved = await membersService.resolveMembersForUsers(wsId, [ownerId]);
    const owner_ = resolved.get(ownerId);
    expect(owner_, 'owner assignee must resolve to a Members row').toBeTruthy();
    expect(owner_!.name).toBe('AssigneeOwner');
    expect(owner_!.email).toBe(owner.email);
    expect(owner_!.active).toBe(true);
    // The resolved recordId is a real Members-database record (the relation target).
    const rows = await memberRows();
    expect(rows.some((r) => r.id === owner_!.recordId && r.values['user_id'] === ownerId)).toBe(true);
  });

  it('resolves a newly-set assignee to its Members row', async () => {
    const created = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Fresh task', [assigneeApi]: aliceId },
    });
    expect(created.statusCode, created.body).toBe(201);
    // The stored value is unchanged — still the bare user id (back-compat).
    expect(created.json().values[assigneeApi]).toBe(aliceId);

    const resolved = await membersService.resolveMembersForUsers(wsId, [aliceId]);
    const alice_ = resolved.get(aliceId);
    expect(alice_, 'alice assignee must resolve').toBeTruthy();
    expect(alice_!.name).toBe('AssigneeAlice');
    expect(alice_!.email).toBe(alice.email);
  });

  it('existing assignee filters and sorts still work (no regression)', async () => {
    const queryUrl = `/workspaces/${wsId}/databases/${tasksDb}/records/query`;

    const filtered = (
      await as(owner.token, 'POST', queryUrl, { filter: { field: assigneeApi, op: 'has', value: [aliceId] } })
    ).json();
    const titles = filtered.data.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(['Alice task', 'Fresh task']);

    // "me" resolution still resolves against the current user's own assignments.
    const mine = (
      await as(owner.token, 'POST', queryUrl, { filter: { field: assigneeApi, op: 'has', value: ['me'] } })
    ).json();
    expect(mine.data.map((r: { title: string }) => r.title)).toEqual(['Owner task']);

    // Sorting by the user field is unaffected.
    const sorted = await as(owner.token, 'POST', queryUrl, { sorts: [{ field: assigneeApi, direction: 'asc' }] });
    expect(sorted.statusCode, sorted.body).toBe(201);
    expect(sorted.json().data.length).toBe(3);
  });

  it('an assignee pointing at a tombstoned (removed) member resolves to the inactive row', async () => {
    // Assign a task to carol, then remove carol's membership.
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Carol task', [assigneeApi]: carolId },
    });

    const members = (await as(owner.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { email: string };
    }>;
    const carolMembership = members.find((m) => m.user.email === carol.email)!;
    const del = await as(owner.token, 'DELETE', `/workspaces/${wsId}/members/${carolMembership.id}`);
    expect(del.statusCode, del.body).toBe(200);
    await settle();

    const resolved = await membersService.resolveMembersForUsers(wsId, [carolId]);
    const carol_ = resolved.get(carolId);
    expect(carol_, 'a removed member must still resolve, not error').toBeTruthy();
    expect(carol_!.active).toBe(false);
    expect(carol_!.name).toBe('AssigneeCarol');
  });

  it('backfill recreates a missing Members row for a referenced (non-member) assignee', async () => {
    // Simulate existing data whose assignee has no Members row: delete carol's
    // (now-tombstoned) row directly. Carol is no longer an active membership, so
    // only the assignee-reconciliation path can restore her.
    const dbId = await membersDbId();
    const carolRow = (await memberRows()).find((r) => r.values['user_id'] === carolId)!;
    const del = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${carolRow.id}`);
    expect(del.statusCode, del.body).toBe(200);

    // Gone now.
    expect((await membersService.resolveMembersForUsers(wsId, [carolId])).get(carolId)).toBeUndefined();

    await membersService.backfillWorkspace(wsId);

    const restored = (await membersService.resolveMembersForUsers(wsId, [carolId])).get(carolId);
    expect(restored, 'backfill must recreate the missing row for an assigned user').toBeTruthy();
    expect(restored!.active).toBe(false); // not a current membership → inactive
    expect(restored!.name).toBe('AssigneeCarol');
  });

  it('backfillWorkspace is idempotent — no duplicate Members rows for assignees', async () => {
    const before = await memberRows();
    await membersService.backfillWorkspace(wsId);
    await membersService.backfillWorkspace(wsId);
    const after = await memberRows();

    expect(after).toHaveLength(before.length);
    // Exactly one row per referenced user id — no duplicates from re-running.
    for (const userId of [ownerId, aliceId, carolId]) {
      expect(after.filter((r) => r.values['user_id'] === userId)).toHaveLength(1);
    }
  });

  it('unknown / empty user ids resolve to nothing (never throw)', async () => {
    const resolved = await membersService.resolveMembersForUsers(wsId, [
      '',
      '   ',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]);
    expect(resolved.size).toBe(0);
  });
});
