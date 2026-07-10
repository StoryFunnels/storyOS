import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;
let recId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Star');
  wsId = (await inject('POST', '/workspaces', { name: 'Fav WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  recId = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Ship it' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('favorites (MN-075)', () => {
  it('stars a record and a database, lists with resolved titles', async () => {
    expect((await inject('POST', `/workspaces/${wsId}/favorites`, { target_type: 'record', target_id: recId })).statusCode).toBe(201);
    expect((await inject('POST', `/workspaces/${wsId}/favorites`, { target_type: 'database', target_id: dbId })).statusCode).toBe(201);

    const list = (await inject('GET', `/workspaces/${wsId}/favorites`)).json();
    const rec = list.find((f: { target_type: string }) => f.target_type === 'record');
    const db = list.find((f: { target_type: string }) => f.target_type === 'database');
    expect(rec).toMatchObject({ target_id: recId, title: 'Ship it', database_id: dbId });
    expect(db).toMatchObject({ target_id: dbId, title: 'Tasks' });
  });

  it('starring twice is idempotent', async () => {
    await inject('POST', `/workspaces/${wsId}/favorites`, { target_type: 'record', target_id: recId });
    const list = (await inject('GET', `/workspaces/${wsId}/favorites`)).json();
    expect(list.filter((f: { target_id: string }) => f.target_id === recId)).toHaveLength(1);
  });

  it('unstars', async () => {
    expect((await inject('DELETE', `/workspaces/${wsId}/favorites/record/${recId}`)).statusCode).toBe(200);
    const list = (await inject('GET', `/workspaces/${wsId}/favorites`)).json();
    expect(list.some((f: { target_id: string }) => f.target_id === recId)).toBe(false);
  });

  it('a deleted record drops out of favorites', async () => {
    await inject('POST', `/workspaces/${wsId}/favorites`, { target_type: 'record', target_id: recId });
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`);
    const list = (await inject('GET', `/workspaces/${wsId}/favorites`)).json();
    expect(list.some((f: { target_id: string }) => f.target_id === recId)).toBe(false);
  });
});
