import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Numberer');
  wsId = (await inject('POST', '/workspaces', { name: 'IDs WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('public record id (MN-087)', () => {
  it('creates an `id` system field, first, non-editable, non-deletable', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const idField = detail.fields.find((f: { type: string }) => f.type === 'id');
    expect(idField, 'id system field exists').toBeTruthy();
    expect(idField.apiName).toBe('id');
    expect(idField.isSystem).toBe(true);
    // renders before the title
    const title = detail.fields.find((f: { type: string }) => f.type === 'title');
    expect(idField.position).toBeLessThan(title.position);

    // cannot be edited or deleted
    const edit = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${idField.id}`, { display_name: 'Nope' });
    expect(edit.statusCode).toBe(422);
    const del = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${idField.id}`);
    expect(del.statusCode).toBe(422);
  });

  it('assigns gap-free sequential numbers per database, exposed top-level', async () => {
    const a = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'First' } });
    const b = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Second' } });
    expect(a.json().number).toBe(1);
    expect(b.json().number).toBe(2);
    // `id` is not in the user values map (it lives top-level as `number`)
    expect(a.json().values.id).toBeUndefined();
  });

  it('numbers are per-database (a fresh database restarts at 1)', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const other = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Other' })).json().id;
    const rec = await inject('POST', `/workspaces/${wsId}/databases/${other}/records`, { values: { name: 'Solo' } });
    expect(rec.json().number).toBe(1);
  });

  it('batch create allocates a contiguous block', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
      records: [{ values: { name: 'Third' } }, { values: { name: 'Fourth' } }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const nums = res.json().data.map((r: { number: number }) => r.number).sort((x: number, y: number) => x - y);
    expect(nums).toEqual([3, 4]);
  });

  it('resolves a record by its public number, and 404s for a missing one', async () => {
    const ok = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/by-number/2`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().title).toBe('Second');
    const miss = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/by-number/9999`);
    expect(miss.statusCode).toBe(404);
  });

  it('rejects writes to the read-only id field', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Fifth' } })).json();
    const write = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, { values: { id: 42 } });
    expect(write.statusCode).toBe(422);
    // the number is unchanged
    const after = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    expect(after.number).toBe(rec.number);
  });

  it('sorts by id via the query engine', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      sorts: [{ field: 'id', direction: 'desc' }],
      limit: 3,
    });
    expect(res.statusCode, res.body).toBe(201);
    const nums = res.json().data.map((r: { number: number }) => r.number);
    expect(nums).toEqual([...nums].sort((a: number, b: number) => b - a));
  });
});
