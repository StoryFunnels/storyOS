import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #417 — deleting a space is the largest destructive action in the product, and
 * it had no guard anywhere on the server.
 *
 * `spaces → databases → records` is a hard-delete CASCADE. Records carry
 * `deletedAt` for the trash, but a cascade removes the ROWS, so the trash cannot
 * recover any of it. The only protection was a client-side `if
 * (databases.length > 0)` in the sidebar — which meant MCP, a script or curl
 * destroyed every database and record in a space with no friction at all.
 *
 * These assert the guard where every caller meets it: the service.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'space-guard');
  wsId = (await as('POST', '/workspaces', { name: 'Guard Co' })).json().id;
});
afterAll(async () => { await app?.close(); });

async function makeSpace(name: string) {
  const res = await as('POST', `/workspaces/${wsId}/spaces`, { name });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().id as string;
}

describe('a space holding databases cannot be deleted without the typed name', () => {
  let spaceId: string;

  beforeAll(async () => {
    spaceId = await makeSpace('Populated');
    const db = await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Deals' });
    expect(db.statusCode).toBeLessThan(300);
    await as('POST', `/workspaces/${wsId}/databases/${db.json().id}/records`, { values: { name: 'Alpha' } });
  });

  it('refuses with no confirm at all', async () => {
    const res = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, {});
    expect(res.statusCode).toBe(422);
  });

  it('refuses a WRONG name — a near miss must not pass', async () => {
    const res = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, { confirm: 'populated' });
    expect(res.statusCode, 'case-sensitive: "populated" is not "Populated"').toBe(422);
  });

  it('names the blast radius rather than restating the rule', async () => {
    /*
     * The message has to answer "should I?", not "what do I type?". Naming the
     * databases is what lets someone realise they are about to lose the wrong
     * thing — the count alone reads as a formality.
     */
    const res = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, {});
    const message = JSON.stringify(res.json());
    expect(message).toContain('Deals');
    expect(message).toMatch(/cannot be undone/i);
    expect(message).toMatch(/trash cannot recover/i);
  });

  it('deletes ONLY with the exact name, and reports what went with it', async () => {
    const res = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, { confirm: 'Populated' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().databases_deleted).toBe(1);

    const left = await as('GET', `/workspaces/${wsId}/spaces`);
    expect(left.json().map((s: { name: string }) => s.name)).not.toContain('Populated');
  });
});

describe('an EMPTY space needs no typed name', () => {
  it('deletes without a confirm', async () => {
    /*
     * Deliberate asymmetry. Demanding ceremony where nothing is at stake is how
     * people learn to type the name without reading the sentence above it — and
     * then do exactly that on the one that matters.
     */
    const spaceId = await makeSpace('Scratch');
    const res = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, {});
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().databases_deleted).toBe(0);
  });
});
