import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AccessService } from '../src/access/access.service';
import { ACCESS_RANK } from '../src/access/access.service';

/**
 * MN-121: the `contributor` rung — read + create + update records, NO delete.
 *
 * The driving case (from the ticket): a client team needs to add work on a few
 * spaces but must not be able to destroy it. That was impossible while every
 * delete required exactly the same rank as the corresponding update.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let client: { token: string; email: string };
let clientId: string;
let member: { token: string; email: string };
let wsId: string;
let clientSpace: string;
let tasks: string;
let notes: string;
let recId: string;
let access: AccessService;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function setGrant(scope: { space_id?: string; database_id?: string }, role: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, {
    user_id: clientId,
    ...scope,
    role,
  });
  expect(res.statusCode, res.body).toBe(201);
}

/**
 * isBillable reads the DB membership row (workspaceId/userId/role), not the
 * presentation shape /members returns — so build the row it expects.
 */
async function membershipOf(userId: string) {
  const rows = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
  const list = Array.isArray(rows) ? rows : rows.data;
  const found = list.find((m: { user: { id: string } }) => m.user.id === userId);
  expect(found, `no membership for ${userId}`).toBeTruthy();
  return { workspaceId: wsId, userId, role: found.role, status: 'active' } as never;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Admin');
  client = await signUpUser(app, 'MabonTeam');
  member = await signUpUser(app, 'Staffer');
  clientId = (await as(client.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Contributor WS' })).json().id;
  clientSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Client Work' })).json().id;
  tasks = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Tasks' })).json().id;
  notes = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Notes' })).json().id;
  recId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records`, { values: { name: 'Existing' } })).json().id;

  // Mabon's case: invite the client as a guest, contributor on the whole space.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: client.email,
    role: 'guest',
    grants: [{ space_id: clientSpace, role: 'contributor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accepted = await as(client.token, 'POST', '/invites/accept', { token });
  expect(accepted.statusCode, accepted.body).toBeLessThan(300);

  const mInvite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const mToken = new URL(mInvite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token: mToken });

  access = app.get(AccessService);
});

afterAll(async () => {
  await app.close();
});

describe('the ladder (MN-121)', () => {
  it('ranks contributor between commenter and editor', () => {
    expect(ACCESS_RANK.commenter).toBeLessThan(ACCESS_RANK.contributor);
    expect(ACCESS_RANK.contributor).toBeLessThan(ACCESS_RANK.editor);
    expect(ACCESS_RANK.editor).toBeLessThan(ACCESS_RANK.creator);
    expect(ACCESS_RANK.creator).toBeLessThan(ACCESS_RANK.admin);
  });

  it('introduces no owner role — admin stays the top rung', () => {
    expect(Object.keys(ACCESS_RANK)).toEqual([
      'viewer',
      'commenter',
      'contributor',
      'editor',
      'creator',
      'admin',
    ]);
  });
});

describe('a contributor CAN add work (MN-121)', () => {
  it('creates a record', async () => {
    const res = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records`, {
      values: { name: 'Added by the client' },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('updates a record', async () => {
    const res = await as(client.token, 'PATCH', `/workspaces/${wsId}/databases/${tasks}/records/${recId}`, {
      values: { name: 'Renamed by the client' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('creates records in batch, and moves one', async () => {
    const batch = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records/batch`, {
      records: [{ values: { name: 'Bulk A' } }, { values: { name: 'Bulk B' } }],
    });
    expect(batch.statusCode, batch.body).toBe(201);
    const move = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records/${recId}/move`, {
      before_record_id: batch.json().data[0].id,
    });
    expect(move.statusCode, move.body).toBeLessThan(300);
  });

  it('reads', async () => {
    expect((await as(client.token, 'GET', `/workspaces/${wsId}/databases/${tasks}/records`)).statusCode).toBe(200);
  });

  it('reaches every database in the granted space — space grants cascade', async () => {
    expect((await as(client.token, 'GET', `/workspaces/${wsId}/databases/${notes}/records`)).statusCode).toBe(200);
    const res = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${notes}/records`, {
      values: { name: 'Cascaded create' },
    });
    expect(res.statusCode, 'a space grant must cover the databases inside it').toBe(201);
  });
});

describe('a contributor CANNOT destroy (MN-121 — the whole point)', () => {
  it('is refused every record delete path', async () => {
    const del = await as(client.token, 'DELETE', `/workspaces/${wsId}/databases/${tasks}/records/${recId}`);
    expect(del.statusCode, 'single delete').toBe(403);

    const batch = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records/batch-delete`, {
      record_ids: [recId],
    });
    expect(batch.statusCode, 'batch delete').toBe(403);
  });

  it('is refused schema changes', async () => {
    const field = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/fields`, {
      display_name: 'Sneaky',
      type: 'text',
    });
    expect(field.statusCode).toBe(403);
  });

  it('is refused views', async () => {
    const view = await as(client.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/views`, {
      name: 'Mine',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(view.statusCode).toBe(403);
  });

  it('the record it could not delete is still there', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${tasks}/records/${recId}`);
    expect(res.statusCode).toBe(200);
  });
});

describe('an editor still deletes — the rung is additive (MN-121)', () => {
  it('promoting the same user to editor unlocks delete', async () => {
    await setGrant({ space_id: clientSpace }, 'editor');
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasks}/records`, {
        values: { name: 'Deletable' },
      })
    ).json();
    const del = await as(client.token, 'DELETE', `/workspaces/${wsId}/databases/${tasks}/records/${rec.id}`);
    expect(del.statusCode, res_body(del)).toBeLessThan(300);
    // …and back down again for the billing checks below.
    await setGrant({ space_id: clientSpace }, 'contributor');
  });
});

function res_body(r: { body: string }) {
  return r.body;
}

describe('the billing predicate (MN-121)', () => {
  it('a contributor guest is billable — they can create', async () => {
    const m = await membershipOf(clientId);
    expect(await access.isBillable(m)).toBe(true);
  });

  it('a viewer-only guest is NOT billable — "viewers and guests are always free"', async () => {
    await setGrant({ space_id: clientSpace }, 'viewer');
    const m = await membershipOf(clientId);
    expect(await access.isBillable(m)).toBe(false);
  });

  it('a commenter is NOT billable', async () => {
    await setGrant({ space_id: clientSpace }, 'commenter');
    const m = await membershipOf(clientId);
    expect(await access.isBillable(m)).toBe(false);
  });

  it('members and admins are always billable', async () => {
    const adminId = (await as(admin.token, 'GET', '/me')).json().id;
    const memberId = (await as(member.token, 'GET', '/me')).json().id;
    expect(await access.isBillable(await membershipOf(adminId))).toBe(true);
    expect(await access.isBillable(await membershipOf(memberId))).toBe(true);
  });

  it('counts seats: admin + member, but not the commenter guest', async () => {
    const billable = await access.billableUserIds(wsId);
    expect(billable).not.toContain(clientId);
    expect(billable).toHaveLength(2);
  });

  it('the guest joins the seat count the moment they can create', async () => {
    await setGrant({ space_id: clientSpace }, 'contributor');
    const billable = await access.billableUserIds(wsId);
    expect(billable).toContain(clientId);
    expect(billable).toHaveLength(3);
  });
});
