import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 4 — search / my-work / recent for a guest whose ONLY access to
 * a database is one or more record-scoped grants (#472). Before this,
 * `visibleDatabaseIds` (database-granular) excluded such a database
 * entirely, so a record-scoped-only guest found NOTHING through search, my
 * work, or recent — not even their own granted record. That's the wrong
 * failure mode: #472 grants a specific record, and the whole point of a
 * record-scoped grant is that the named record IS reachable.
 *
 * THIS IS A SECURITY BOUNDARY: every assertion uses a real guest with a
 * real record-scoped grant, and confirms the sibling record (same
 * database, NOT granted) never appears — the over-widening failure mode
 * would be just as real a bug as under-widening.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let dbId: string;
let recGranted: string;
let recDenied: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RecScopeSearchOwner');
  guest = await signUpUser(app, 'RecScopeSearchGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p4 Search WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Client Briefs' })).json().id;

  const assigneeField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Assignee', type: 'user',
  });
  const assigneeApi = assigneeField.json().apiName;

  recGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Phoenix granted brief' } })).json().id;
  recDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Phoenix denied brief' } })).json().id;

  // A record-scoped grant is required to invite a guest at all — the invite
  // grant IS the guest's only access: no space/database grant anywhere.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: recGranted, role: 'editor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  // Assign the guest to BOTH records (not just the granted one) — my-work's
  // narrowing must be doing real work, not just happening to match because
  // only the granted record was ever assigned to them.
  await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}`, { values: { [assigneeApi]: guestId } });
  await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recDenied}`, { values: { [assigneeApi]: guestId } });
});

afterAll(async () => {
  await app.close();
});

describe('#474 phase 4 — search/my-work/recent for a record-scoped-only guest', () => {
  it('search finds the granted record by title — not absent just because the database is not fully granted', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/search?q=phoenix`);
    expect(res.statusCode, res.body).toBe(200);
    const titles = res.json().records.map((r: { title: string }) => r.title);
    expect(titles).toContain('Phoenix granted brief');
  });

  it('search NEVER surfaces the sibling record in the same database — a record grant does not widen to the whole database', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/search?q=phoenix`);
    const titles = res.json().records.map((r: { title: string }) => r.title);
    expect(titles).not.toContain('Phoenix denied brief');
  });

  it('search never leaks the database/space as a discoverable "place" via a bare record-scoped grant', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/search?q=client`);
    expect(res.json().places).toEqual([]);
  });

  it('my-work (assigned tab) narrows to exactly the granted record, even though BOTH records are assigned to the guest', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/my-work?tab=assigned`);
    expect(res.statusCode, res.body).toBe(200);
    const group = res.json().groups.find((g: { database: { id: string } }) => g.database.id === dbId);
    expect(group, 'the Client Briefs group is present').toBeTruthy();
    const ids = (group.records as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([recGranted]);
  });

  it('my-work (created tab) is empty — the guest created neither record, proving this is not just "everything reachable"', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/my-work?tab=created`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('recent includes the granted record when the guest has touched it, never the denied sibling', async () => {
    // A bare read logs no activity event — an edit does. The grant above is
    // 'editor' specifically so this write is legal for the guest to make.
    await as(guest.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recGranted}`, {
      values: { name: 'Phoenix granted brief (touched)' },
    });
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/recent`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().records as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(recGranted);
    expect(ids).not.toContain(recDenied);
  });
});
