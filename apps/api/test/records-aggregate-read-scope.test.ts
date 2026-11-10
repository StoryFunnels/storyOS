import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1261 — the MCP lists count_records / count_records_grouped as READ tools, but both POST, and an unmarked POST needs a WRITE
 * token (auth.guard.ts requiredTokenScope). So a read token that was offered the count got a 403. Both routes are reads
 * (viewer access, nothing is created), so they carry @RequiresScope('read'), as `query` does.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let wsId: string;
let dbId: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

const mint = async (scope: 'read' | 'write'): Promise<string> => {
  const r = await as(owner.token, 'POST', '/me/tokens', { name: `pat-${scope}`, workspace_id: wsId, scope });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().token;
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Scope Owner');
  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Scope Co' })).json().id;
  const spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Items' })).json().id;
  const f = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Done', type: 'checkbox' });
  expect(f.statusCode, f.body).toBeLessThan(300);
  const rec = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
    records: [{ values: { name: 'a', done: true } }, { values: { name: 'b', done: false } }, { values: { name: 'c', done: true } }],
  });
  expect(rec.statusCode, rec.body).toBeLessThan(300);
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('#1261 a READ token can count, and still cannot write', () => {
  it('count (aggregate) and the grouped count both answer 200 to a read token with the true numbers', async () => {
    const read = await mint('read');
    const total = await as(read, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate`, { op: 'count' });
    expect(total.statusCode, total.body).toBe(200);
    expect(total.json().value).toBe(3);
    const grouped = await as(read, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate/grouped`, { op: 'count', group_by: 'done' });
    expect(grouped.statusCode, grouped.body).toBe(200);
    expect(grouped.json().groups.length).toBeGreaterThan(0);
  });

  it('the same read token is still refused a write (a record create, a batch create)', async () => {
    const read = await mint('read');
    const one = await as(read, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'x' } });
    expect(one.statusCode).toBe(403);
    const batch = await as(read, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, { records: [{ values: { name: 'y' } }] });
    expect(batch.statusCode).toBe(403);
  });
});
