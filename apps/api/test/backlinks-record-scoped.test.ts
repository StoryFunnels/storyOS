import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 5 — backlinks ("Mentioned in") for a guest whose only access to
 * the SOURCE database (the one containing records that mention the target)
 * is one or more record-scoped grants (#472). Before this, `backlinks()`
 * gated purely on `visibleDatabaseIds` (database-granular), so a
 * record-scoped-only guest never saw a mentioning record they were
 * specifically granted — the same under-widening bug phases 3-4 fixed
 * elsewhere. Also fixes a related over-widening bug found while building
 * this: the controller's OWN gate on the TARGET record used to be
 * database-level only, so a guest granted record X could read record Y's
 * backlinks in the same database.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let tasksDb: string;
let sourceGranted: string;
let sourceDenied: string;
let target: string;
let otherTarget: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

const docMentioning = (...recordIds: string[]) => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'see ', styles: {} },
      ...recordIds.map((id) => ({ type: 'mention', props: { kind: 'record', id, label: 'x' } })),
    ],
  },
];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'BacklinkScopeOwner');
  guest = await signUpUser(app, 'BacklinkScopeGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p5 Backlinks WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  target = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Target' } })).json().id;
  otherTarget = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Other Target' } })).json().id;
  sourceGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Granted Source' } })).json().id;
  sourceDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Denied Source' } })).json().id;

  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${sourceGranted}/document`, {
    content: docMentioning(target),
    expected_version: 0,
  });
  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${sourceDenied}/document`, {
    content: docMentioning(target),
    expected_version: 0,
  });

  // A record-scoped grant is required to invite a guest at all — the invite
  // grant IS the guest's only access: no space/database grant anywhere.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [
      { record_id: target, role: 'viewer' },
      { record_id: sourceGranted, role: 'viewer' },
    ],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('#474 phase 5 — backlinks for a record-scoped-only guest', () => {
  it('includes the granted mentioning record, never the denied sibling that mentions the same target', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${target}/backlinks`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(sourceGranted);
    expect(ids).not.toContain(sourceDenied);
    expect(res.json().total).toBe(1);
  });

  it('a guest granted record X cannot read the backlinks of an unrelated record Y in the same database (the target-record gate is per-record, not per-database)', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${otherTarget}/backlinks`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the admin (unrestricted) still sees every mentioning record', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${target}/backlinks`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids.sort()).toEqual([sourceGranted, sourceDenied].sort());
  });
});
