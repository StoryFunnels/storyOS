import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 6 — activity, record versions, and comments for a guest whose
 * only access to a database is one or more record-scoped grants (#472).
 * All three controllers used to gate on `assertAccess(db, min)` +
 * `getRow`/existence only — database-level, so a guest granted record A
 * could read record B's activity trail, version history, and comment
 * thread in the same database, and could restore a previous version of a
 * record they were never granted. Fixed by switching every one of these
 * to `RecordsService.assertRecordAccess`, the per-record check every
 * single-record read route was always supposed to use.
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
let versionId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'CollabScopeOwner');
  guest = await signUpUser(app, 'CollabScopeGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p6 Collab WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Briefs' })).json().id;

  recGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Granted Brief' } })).json().id;
  recDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Denied Brief' } })).json().id;

  // A real edit on each, so activity/version history exists to read.
  await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}`, { values: { name: 'Granted Brief (v2)' } });
  await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}`, { values: { name: 'Denied Brief (v2)' } });
  const versions = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/versions`);
  versionId = (versions.json().data as Array<{ id: string }>)[0]!.id;

  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/comments`, {
    body: [{ type: 'text', text: 'a comment on the granted record' }],
  });
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/comments`, {
    body: [{ type: 'text', text: 'a comment on the denied record' }],
  });

  // A record-scoped grant is required to invite a guest at all — the invite
  // grant IS the guest's only access: no space/database grant anywhere.
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

describe('#474 phase 6 — activity/versions/comments for a record-scoped-only guest', () => {
  it('activity: the guest reads the granted record\'s trail', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/activity`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("activity: the guest CANNOT read the denied sibling's trail in the same database", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/activity`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it("versions: the guest reads the granted record's history", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/versions`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as unknown[]).length).toBeGreaterThan(0);
  });

  it("versions: the guest CANNOT read the denied sibling's history", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/versions`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it("versions/changes: the guest CANNOT read the denied sibling's field-change history either", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/versions/changes`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('versions/restore: the guest can restore a version of the record they were granted (editor role)', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/versions/${versionId}/restore`);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('versions/restore: the guest CANNOT restore any version of the denied sibling', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/versions/${versionId}/restore`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it("comments: the guest reads the granted record's thread", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/comments`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as unknown[]).length).toBeGreaterThan(0);
  });

  it("comments: the guest CANNOT read the denied sibling's thread", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/comments`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('comments: the guest can post on the granted record but not the denied sibling', async () => {
    const ok = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}/comments`, {
      body: [{ type: 'text', text: 'guest comment' }],
    });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    const denied = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/comments`, {
      body: [{ type: 'text', text: 'should not land' }],
    });
    expect(denied.statusCode, denied.body).toBe(404);
  });

  it('the admin (unrestricted) still reads everything unchanged', async () => {
    const activity = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/activity`);
    expect(activity.statusCode).toBe(200);
    const versions = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/versions`);
    expect(versions.statusCode).toBe(200);
    const comments = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}/comments`);
    expect(comments.statusCode).toBe(200);
  });
});
