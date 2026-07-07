import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let generalSpaceId: string;
let clientSpaceId: string;
let tasksDbId: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Builder');

  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'DB Test WS' },
  });
  wsId = ws.json().id;

  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  generalSpaceId = spaces.json()[0].id;

  const clientSpace = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
    payload: { name: 'Client Work' },
  });
  clientSpaceId = clientSpace.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('databases CRUD (MN-009)', () => {
  it('creates a database with title field, system fields, and default view', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: clientSpaceId, name: 'Tasks' },
    });
    expect(res.statusCode).toBe(201);
    tasksDbId = res.json().id;
    expect(res.json().apiSlug).toBe('tasks');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
    });
    const body = detail.json();
    expect(body.fields.map((f: { apiName: string }) => f.apiName)).toEqual([
      'name',
      'created_at',
      'updated_at',
      'created_by',
    ]);
    expect(body.fields[0].type).toBe('title');
    expect(body.views).toHaveLength(1);
    expect(body.views[0].type).toBe('table');
  });

  it('generates unique api slugs per workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Tasks' },
    });
    expect(res.json().apiSlug).toBe('tasks_2');
  });

  it('guests see only databases in their scoped spaces (list + direct get)', async () => {
    const dana = await signUpUser(app, 'DanaG');
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/invites`,
      headers: authed(admin.token),
      payload: { email: dana.email, role: 'guest', space_ids: [clientSpaceId] },
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(dana.token),
      payload: { token },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(dana.token),
    });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([tasksDbId]);

    const general = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
    });
    const otherDbId = general.json().find((d: { id: string }) => d.id !== tasksDbId).id;

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${otherDbId}`,
      headers: authed(dana.token),
    });
    expect(forbidden.statusCode).toBe(404);

    const write = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(dana.token),
      payload: { space_id: clientSpaceId, name: 'Nope' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('moving a database to another space changes guest visibility', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().spaceId).toBe(generalSpaceId);

    // move it back for later tests
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { space_id: clientSpaceId },
    });
  });

  it('delete requires the exact database name as confirmation', async () => {
    const wrong = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { confirm: 'nope' },
    });
    expect(wrong.statusCode).toBe(409);

    const right = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { confirm: 'Tasks' },
    });
    expect(right.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
    });
    expect(gone.statusCode).toBe(404);
  });
});
