import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { activityEvents } from '../src/db/schema';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateFieldOptions: Array<{ id: string; label: string }>;
const { db, pool } = connectTestDb();

const base = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Recorder');
  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Records WS' },
  });
  wsId = ws.json().id;
  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  const database = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases`,
    headers: authed(admin.token),
    payload: { space_id: spaces.json()[0].id, name: 'Tasks' },
  });
  dbId = database.json().id;

  const stateField = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload: {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done', color: 'green' }],
    },
  });
  stateFieldOptions = stateField.json().options;

  await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload: { display_name: 'Estimate', type: 'number' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('records CRUD (MN-011)', () => {
  let recId: string;

  it('creates a record with values keyed by api_name and stamps created_by', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: {
        values: { name: 'Ship v1', state: stateFieldOptions[0]!.id, estimate: 8 },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const rec = res.json();
    recId = rec.id;
    expect(rec.title).toBe('Ship v1');
    expect(rec.values).toEqual({ state: stateFieldOptions[0]!.id, estimate: 8 });
    expect(rec.created_by).toBeTruthy();
    expect(rec.position).toBeTruthy();
  });

  it('emits record.created activity in the same transaction', async () => {
    const events = await db.query.activityEvents.findMany({
      where: eq(activityEvents.recordId, recId),
    });
    expect(events.map((e) => e.type)).toContain('record.created');
  });

  it('rejects bad values with per-path 422 details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: { values: { nope: 1, estimate: 'many', state: 'bad-option' } },
    });
    expect(res.statusCode).toBe(422);
    const details = res.json().error.details;
    expect(details.map((d: { path: string }) => d.path).sort()).toEqual([
      'values.estimate',
      'values.nope',
      'values.state',
    ]);
  });

  it('PATCH merges values; explicit null clears a key; diff lands in activity', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/${recId}`,
      headers: authed(admin.token),
      payload: { values: { estimate: null, state: stateFieldOptions[1]!.id } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values).toEqual({ state: stateFieldOptions[1]!.id });

    const events = await db.query.activityEvents.findMany({
      where: eq(activityEvents.recordId, recId),
    });
    const update = events.find((e) => e.type === 'record.updated');
    expect(update).toBeDefined();
    const diff = (update!.payload as { diff: Record<string, { from: unknown; to: unknown }> }).diff;
    expect(Object.keys(diff)).toHaveLength(2);
  });

  it('orphan values from deleted fields disappear from reads', async () => {
    const field = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
      headers: authed(admin.token),
      payload: { display_name: 'Temp', type: 'text' },
    });
    await app.inject({
      method: 'PATCH',
      url: `${base()}/${recId}`,
      headers: authed(admin.token),
      payload: { values: { temp: 'ephemeral' } },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.json().id}`,
      headers: authed(admin.token),
    });

    const rec = await app.inject({ method: 'GET', url: `${base()}/${recId}`, headers: authed(admin.token) });
    expect(rec.json().values.temp).toBeUndefined();
  });

  it('soft delete → trash → restore round-trip', async () => {
    await app.inject({ method: 'DELETE', url: `${base()}/${recId}`, headers: authed(admin.token) });

    const gone = await app.inject({ method: 'GET', url: `${base()}/${recId}`, headers: authed(admin.token) });
    expect(gone.statusCode).toBe(404);

    const trash = await app.inject({ method: 'GET', url: `${base()}/trash`, headers: authed(admin.token) });
    expect(trash.json().data.map((r: { id: string }) => r.id)).toContain(recId);

    const restored = await app.inject({
      method: 'POST',
      url: `${base()}/${recId}/restore`,
      headers: authed(admin.token),
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().title).toBe('Ship v1');
  });

  it('batch create is atomic and ≤100', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { records: Array.from({ length: 20 }, (_, i) => ({ values: { name: `Bulk ${i}` } })) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toHaveLength(20);

    const tooMany = await app.inject({
      method: 'POST',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { records: Array.from({ length: 101 }, () => ({ values: {} })) },
    });
    expect(tooMany.statusCode).toBe(422);
  });

  it('lists with cursor pagination and q search', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: `${base()}?limit=10`,
      headers: authed(admin.token),
    });
    expect(page1.json().data).toHaveLength(10);
    expect(page1.json().has_more).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${base()}?limit=10&cursor=${page1.json().next_cursor}`,
      headers: authed(admin.token),
    });
    const ids1 = page1.json().data.map((r: { id: string }) => r.id);
    const ids2 = page2.json().data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);

    const search = await app.inject({
      method: 'GET',
      url: `${base()}?q=Ship`,
      headers: authed(admin.token),
    });
    expect(search.json().data.map((r: { title: string }) => r.title)).toContain('Ship v1');
  });

  it('guests can read but not write records', async () => {
    const guest = await signUpUser(app, 'GuestRec');
    const spaces = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
    });
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/invites`,
      headers: authed(admin.token),
      payload: { email: guest.email, role: 'guest', grants: [{ space_id: spaces.json()[0].id, role: 'commenter' }] },
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(guest.token),
      payload: { token },
    });

    const read = await app.inject({ method: 'GET', url: base(), headers: authed(guest.token) });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(guest.token),
      payload: { values: { name: 'nope' } },
    });
    expect(write.statusCode).toBe(403);
  });
});
