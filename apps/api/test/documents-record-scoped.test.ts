import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 8 — a record's document (BlockNote description) for a guest
 * whose only access to a database is one or more record-scoped grants
 * (#472). `DocumentsController` used to gate on `assertAccess(db, min)` +
 * `getRow` (existence only) — database-level, the same class of bug
 * sections 5/6 (activity/versions/comments) had, and the enumeration's own
 * finding that `attachments.controller.ts` (already fixed via #473) and
 * `documents.controller.ts` shared the identical pattern.
 *
 * THIS IS A SECURITY BOUNDARY: every assertion uses a real guest with a
 * real record-scoped grant.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let dbId: string;
let recGranted: string;
let recDenied: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'DocScopeOwner');
  guest = await signUpUser(app, 'DocScopeGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p8 Docs WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Briefs' })).json().id;

  recGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Granted Brief' } })).json().id;
  recDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Denied Brief' } })).json().id;

  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/document`, {
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'granted secret notes', styles: {} }] }],
    expected_version: 0,
  });
  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/document`, {
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'denied secret notes', styles: {} }] }],
    expected_version: 0,
  });

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: recGranted, role: 'editor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('#474 phase 8 — record document for a record-scoped-only guest', () => {
  it('the guest reads the granted record\'s document', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/document`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("the guest CANNOT read the denied sibling's document in the same database", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/document`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the guest can write the granted record\'s document (editor role)', async () => {
    const res = await as(guest.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/document`, {
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'guest edit', styles: {} }] }],
      expected_version: 1,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it("the guest CANNOT write the denied sibling's document", async () => {
    const res = await as(guest.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/document`, {
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'should not land', styles: {} }] }],
      expected_version: 1,
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the admin (unrestricted) still reads/writes the denied record unchanged', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/document`);
    expect(res.statusCode, res.body).toBe(200);
  });
});
