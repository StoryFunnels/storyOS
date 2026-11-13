import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * Ticket #1299 - "deleting the workspace returned 400".
 *
 * Root cause: there is NO `DELETE /workspaces/:ws` route (api-conventions.md listed one that never existed), and a DELETE that carries
 * `Content-Type: application/json` with no body - what curl -H, many HTTP clients and agents send - was answered by Fastify's JSON
 * parser with 400 "Body cannot be empty..." BEFORE routing, hiding both the real answer (404, no such route) and, on routes that do
 * exist (delete a space, a database...), the route's own refusal. An empty body on DELETE is "no body", not a broken JSON document.
 */
let app: NestFastifyApplication;
let token: string;
let ws: string;
let spaceId: string;
const JSON_CT = { 'content-type': 'application/json' };
const raw = (method: string, url: string, headers: Record<string, string> = {}, payload?: string) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, ...headers }, payload });

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Del Owner')).token;
  ws = (await call(app, token, 'POST', '/workspaces', { name: 'Rule Rig Del' })).json().id;
  spaceId = (await call(app, token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Doomed' })).json().id;
  const d = await call(app, token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Inside' });
  expect(d.statusCode, d.body).toBe(201);
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('#1299 a bodyless DELETE that says it is JSON', () => {
  it('reaches the route: the space refusal (422, names the confirm) comes back instead of a 400 about the body, and nothing is deleted', async () => {
    const res = await raw('DELETE', `/workspaces/${ws}/spaces/${spaceId}`, JSON_CT);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/confirm/);
    expect((await call(app, token, 'GET', `/workspaces/${ws}/spaces`)).json().some((s: { id: string }) => s.id === spaceId)).toBe(true);
  });

  it('DELETE /workspaces/:ws says what is true - there is no such route (404), not a 400', async () => {
    const res = await raw('DELETE', `/workspaces/${ws}`, JSON_CT);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.message).toMatch(/Cannot DELETE/);
    expect((await call(app, token, 'GET', `/workspaces/${ws}`)).statusCode).toBe(200);
  });

  it('MUST KEEP: a DELETE with a real JSON body still works', async () => {
    const res = await raw('DELETE', `/workspaces/${ws}/spaces/${spaceId}`, JSON_CT, JSON.stringify({ confirm: 'Doomed' }));
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('MUST KEEP: a DELETE with a broken JSON body is still a 400', async () => {
    const res = await raw('DELETE', `/workspaces/${ws}/spaces/${spaceId}`, JSON_CT, '{"confirm":');
    expect(res.statusCode, res.body).toBe(400);
  });

  it('MUST KEEP: an empty JSON body on a POST (which needs one) is still the 400', async () => {
    const res = await raw('POST', '/workspaces', JSON_CT);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toMatch(/Body cannot be empty/);
  });
});
