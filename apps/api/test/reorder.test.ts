import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * Drag-to-reorder persistence + permission scoping (#337, #338). The UI reorders
 * by writing each moved entity's `position` through the existing PATCH endpoints;
 * these tests lock in that a written position order (a) survives a re-read and
 * (b) is refused to callers who lack the right access.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let outsider: { token: string; email: string };
let wsId: string;
let firstSpaceId: string;
let secondSpaceId: string;
let dbId: string;
const { pool } = connectTestDb();

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Reorder Admin');
  outsider = await signUpUser(app, 'Reorder Outsider');

  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Reorder WS' },
  });
  wsId = ws.json().id;

  // A workspace is seeded with one space; add a second so there is something to reorder.
  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  firstSpaceId = spaces.json()[0].id;

  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
    payload: { name: 'Second Space' },
  });
  secondSpaceId = second.json().id;

  const db = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases`,
    headers: authed(admin.token),
    payload: { space_id: firstSpaceId, name: 'Tasks' },
  });
  dbId = db.json().id;

  // Two user fields to reorder alongside the frozen system fields.
  for (const name of ['Status', 'Priority']) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
      headers: authed(admin.token),
      payload: { display_name: name, type: 'text' },
    });
  }

  // A second view to reorder against the default table view.
  const view = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/views`,
    headers: authed(admin.token),
    payload: { name: 'Second view', type: 'table', config: {} },
  });
  if (view.statusCode >= 300) throw new Error(`view create failed: ${view.statusCode} ${view.body}`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const listSpaces = async (token: string) =>
  (
    await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/spaces`, headers: authed(token) })
  ).json() as Array<{ id: string; position: number }>;

const listDatabases = async () =>
  (
    await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/databases`, headers: authed(admin.token) })
  ).json() as Array<{ id: string; position: number }>;

const getDb = async () =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}`,
      headers: authed(admin.token),
    })
  ).json() as {
    fields: Array<{ id: string; apiName: string; type: string; isSystem: boolean; position: number }>;
    views: Array<{ id: string; name: string; position: number }>;
  };

describe('spaces reorder (#337)', () => {
  it('persists a new space order and it survives a re-read', async () => {
    const before = await listSpaces(admin.token);
    const [a, b] = before;
    // Swap the two spaces by writing contiguous positions, as the sidebar does.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/spaces/${b!.id}`,
      headers: authed(admin.token),
      payload: { position: 0 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/spaces/${a!.id}`,
      headers: authed(admin.token),
      payload: { position: 1 },
    });
    const after = await listSpaces(admin.token);
    expect(ids(after)).toEqual([b!.id, a!.id]);
    // Restore for later isolation.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/spaces/${a!.id}`,
      headers: authed(admin.token),
      payload: { position: 0 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/spaces/${b!.id}`,
      headers: authed(admin.token),
      payload: { position: 1 },
    });
  });

  it('refuses reorder from a non-member of the workspace', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/spaces/${firstSpaceId}`,
      headers: authed(outsider.token),
      payload: { position: 5 },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('databases reorder (#337)', () => {
  it('persists database position within a space', async () => {
    // A second database in the same space to reorder against.
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: firstSpaceId, name: 'Projects' },
    });
    const secondDbId = second.json().id;

    const inSpace = (rows: Array<{ id: string; spaceId?: string }>) =>
      rows.filter((d) => (d as { spaceId?: string }).spaceId === firstSpaceId);

    const before = inSpace(await listDatabases());
    const first = before[0]!;
    // Move the newly-created second db to the front.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${secondDbId}`,
      headers: authed(admin.token),
      payload: { position: 0 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${first.id}`,
      headers: authed(admin.token),
      payload: { position: 1 },
    });
    const after = inSpace(await listDatabases());
    expect(after[0]!.id).toBe(secondDbId);
  });
});

describe('fields reorder (#338)', () => {
  // The title ("name") field is not flagged isSystem but is never user-reorderable
  // in the UI (frozen column / excluded from the Hide-fields panel), so the
  // "movable" set is the non-system, non-title fields.
  const movable = (fields: Array<{ apiName: string; type: string; isSystem: boolean }>) =>
    fields.filter((f) => !f.isSystem && f.type !== 'title');

  it('persists a user field order across a re-read', async () => {
    const before = await getDb();
    const user = movable(before.fields);
    expect(user.map((f) => f.apiName)).toEqual(['status', 'priority']);

    const status = before.fields.find((f) => f.apiName === 'status')!;
    const priority = before.fields.find((f) => f.apiName === 'priority')!;
    // Swap their positions (priority before status).
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${priority.id}`,
      headers: authed(admin.token),
      payload: { position: status.position },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${status.id}`,
      headers: authed(admin.token),
      payload: { position: priority.position },
    });

    const after = await getDb();
    expect(movable(after.fields).map((f) => f.apiName)).toEqual(['priority', 'status']);
  });

  it('rejects reordering a system field (422)', async () => {
    const { fields } = await getDb();
    const idField = fields.find((f) => f.type === 'id')!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${idField.id}`,
      headers: authed(admin.token),
      payload: { position: 9 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses field reorder from a non-member', async () => {
    const { fields } = await getDb();
    const target = fields.find((f) => !f.isSystem)!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${target.id}`,
      headers: authed(outsider.token),
      payload: { position: 0 },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('views reorder (#337)', () => {
  it('persists view tab order across a re-read', async () => {
    const before = await getDb();
    expect(before.views.length).toBeGreaterThanOrEqual(2);
    const [first, second] = before.views;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/views/${second!.id}`,
      headers: authed(admin.token),
      payload: { position: 0 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/views/${first!.id}`,
      headers: authed(admin.token),
      payload: { position: 1 },
    });
    const after = await getDb();
    expect(after.views[0]!.id).toBe(second!.id);
  });
});
