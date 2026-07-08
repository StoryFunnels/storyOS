import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let clientSpace: string;
let internalSpace: string;
let clientTasks: string; // db in clientSpace
let clientNotes: string; // db in clientSpace
let internalDb: string; // db in internalSpace
let recId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { space_id?: string; database_id?: string }, role: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, {
    user_id: guestId,
    ...scope,
    role,
  });
  expect(res.statusCode, res.body).toBe(201);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Owner');
  guest = await signUpUser(app, 'ClientUser');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Access WS' })).json().id;
  internalSpace = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  clientSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Client Work' })).json().id;
  clientTasks = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Tasks' })).json().id;
  clientNotes = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: clientSpace, name: 'Notes' })).json().id;
  internalDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: internalSpace, name: 'Secrets' })).json().id;
  recId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records`, { values: { name: 'Shared task' } })).json().id;

  // invite the guest with a viewer grant on the client space
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ space_id: clientSpace, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('access grants ladder (MN-034, ADR-0007)', () => {
  it('viewer: reads records, cannot comment or edit; ungranted db is 404', async () => {
    const read = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${clientTasks}/records`);
    expect(read.statusCode).toBe(200);
    expect((await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${clientTasks}`)).json().my_access).toBe('viewer');

    const comment = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'hi' }],
    });
    expect(comment.statusCode).toBe(403);

    const write = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records`, { values: { name: 'x' } });
    expect(write.statusCode).toBe(403);

    const secret = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${internalDb}`);
    expect(secret.statusCode).toBe(404);
  });

  it('commenter: comments, still no record writes', async () => {
    await setGrant({ space_id: clientSpace }, 'commenter');
    const comment = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'client feedback' }],
    });
    expect(comment.statusCode, comment.body).toBe(201);

    const write = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records`, { values: { name: 'x' } });
    expect(write.statusCode).toBe(403);
  });

  it('editor ("the client as user"): full record + view work, no schema', async () => {
    await setGrant({ space_id: clientSpace }, 'editor');

    const create = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records`, {
      values: { name: 'Created by the client' },
    });
    expect(create.statusCode, create.body).toBe(201);

    const move = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records/${create.json().id}/move`, {
      after_record_id: recId,
    });
    expect(move.statusCode).toBe(201);

    const view = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/views`, {
      name: 'Client view',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(view.statusCode, view.body).toBe(201);

    const field = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/fields`, {
      display_name: 'Nope',
      type: 'text',
    });
    expect(field.statusCode).toBe(403);

    const members = await as(guest.token, 'GET', `/workspaces/${wsId}/members`);
    expect(members.statusCode).toBe(403);
  });

  it('creator: schema works inside the scope', async () => {
    await setGrant({ space_id: clientSpace }, 'creator');
    const field = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/fields`, {
      display_name: 'Client field',
      type: 'text',
    });
    expect(field.statusCode, field.body).toBe(201);
    expect((await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${clientTasks}`)).json().my_access).toBe('creator');
  });

  it('database-level grant beats the space grant (highest wins) and adds scope', async () => {
    // back to viewer on the space, editor on ONE database
    await setGrant({ space_id: clientSpace }, 'viewer');
    await setGrant({ database_id: clientTasks }, 'editor');

    const writeTasks = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientTasks}/records`, {
      values: { name: 'db-grant write' },
    });
    expect(writeTasks.statusCode).toBe(201);

    const writeNotes = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${clientNotes}/records`, {
      values: { name: 'nope' },
    });
    expect(writeNotes.statusCode).toBe(403); // notes still viewer via space
  });

  it('grants API is admin-only; PATs inherit the guest grants', async () => {
    const asGuest = await as(guest.token, 'POST', `/workspaces/${wsId}/grants`, {
      user_id: guestId,
      space_id: clientSpace,
      role: 'creator',
    });
    expect(asGuest.statusCode).toBe(403);

    const pat = await as(guest.token, 'POST', '/me/tokens', { name: 'client-script', workspace_id: wsId });
    const patWrite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${clientTasks}/records`,
      headers: { authorization: `Bearer ${pat.json().token}` },
      payload: { values: { name: 'via client PAT' } },
    });
    expect(patWrite.statusCode).toBe(201);
  });

  it('revoking the grants closes the door (404)', async () => {
    const grants = await as(admin.token, 'GET', `/workspaces/${wsId}/grants?user_id=${guestId}`);
    for (const grant of grants.json().data) {
      await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${grant.id}`);
    }
    const read = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${clientTasks}`);
    expect(read.statusCode).toBe(404);
  });
});
