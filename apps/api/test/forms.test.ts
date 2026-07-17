import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let token: string;
let wsId: string;
let dbId: string;
let msgFieldId: string;
let nameFieldId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
/** Unauthenticated request (no headers) — the public form path. */
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

async function makeForm(access: 'members' | 'link' | 'public', token_: string) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
    name: `Form ${token_}`,
    type: 'form',
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: {
        title: 'Contact us',
        access,
        public_token: token_,
        fields: [
          { field_id: nameFieldId, required: true, label: 'Your name' },
          { field_id: msgFieldId, help: 'What can we help with?' },
        ],
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'FormOwner')).token;
  wsId = (await as('POST', '/workspaces', { name: 'Forms WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
  // The database ships with a title field ("Name"); reuse it rather than duplicate.
  const dbFields = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields as Array<{ id: string; type: string; api_name: string }>;
  nameFieldId = dbFields.find((f) => f.type === 'title' || f.api_name === 'name')!.id;
  msgFieldId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Message', type: 'text' })).json().id;
});
afterAll(async () => {
  await app.close();
});

describe('public forms (MN-101)', () => {
  it('serves a public form definition without auth', async () => {
    await makeForm('public', 'tok-public');
    const res = await pub('GET', '/public/forms/tok-public');
    expect(res.statusCode, res.body).toBe(200);
    const def = res.json();
    expect(def.title).toBe('Contact us');
    expect(def.fields).toHaveLength(2);
    expect(def.fields[0]).toMatchObject({ api_name: 'name', label: 'Your name', required: true });
    expect(def.fields[1]).toMatchObject({ api_name: 'message', help: 'What can we help with?' });
  });

  it('a members-only form is not public (404)', async () => {
    await makeForm('members', 'tok-members');
    expect((await pub('GET', '/public/forms/tok-members')).statusCode).toBe(404);
    expect((await pub('GET', '/public/forms/does-not-exist')).statusCode).toBe(404);
  });

  it('an anonymous submit creates a record', async () => {
    const res = await pub('POST', '/public/forms/tok-public', {
      values: { name: 'Ada', message: 'Hello from the outside' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().ok).toBe(true);

    // The owner sees the new record; it has no author (anonymous).
    const list = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 50 });
    const rows = list.json().data as Array<{ values: Record<string, unknown>; created_by?: string | null }>;
    expect(rows.some((r) => r.values.message === 'Hello from the outside')).toBe(true);
  });

  it('enforces the form required flags (422)', async () => {
    const res = await pub('POST', '/public/forms/tok-public', { values: { message: 'no name' } });
    expect(res.statusCode).toBe(422);
  });

  it('honeypot submissions are silently dropped (no record)', async () => {
    const before = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data.length;
    const res = await pub('POST', '/public/forms/tok-public', {
      values: { name: 'Bot', message: 'spam' },
      hp: 'i am a bot',
    });
    expect(res.statusCode, res.body).toBe(201);
    const after = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data.length;
    expect(after).toBe(before);
  });
});
