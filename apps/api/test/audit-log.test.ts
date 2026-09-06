import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #454 — a read model and access boundary over data that already exists
 * (activity_events, record_field_changes), not a new event stream.
 *
 * KNOWN, STATED GAP (this ticket's own AC #2, confirmed by reading the
 * three remove() methods before writing any code): structural deletions of
 * a database, view or space are NOT recorded in activity_events today —
 * none of DatabasesService.remove()/SpacesService.remove()/ViewsService
 * .remove() even take an actorId parameter. "Who deleted this database" is
 * NOT answerable from this endpoint; "who changed or deleted this record"
 * is. Flagged as its own follow-up rather than built silently in here.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let dbId: string;
let titleApiName: string;
let adminId: string;
let memberId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'AuditLogAdmin');
  member = await signUpUser(app, 'AuditLogMember');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Audit Log WS' })).json().id;

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token: inviteToken });

  adminId = (await as(admin.token, 'GET', '/me')).json().id;
  memberId = (await as(member.token, 'GET', '/me')).json().id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  const field = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Title',
    type: 'text',
    config: {},
  });
  titleApiName = field.json().apiName;
});

afterAll(async () => {
  await app.close();
});

describe('#454 admin audit log', () => {
  it('AC3/AC1(reproduced): the workspace-wide log shows creates and updates across DIFFERENT users on DIFFERENT records', async () => {
    const byAdmin = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Admin made this' } });
    const byMember = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Member made this' } });
    expect(byAdmin.statusCode).toBe(201);
    expect(byMember.statusCode).toBe(201);

    const log = await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ record_id: string; actor_id: string; actor_name: string }>;

    const adminRow = rows.find((r) => r.record_id === byAdmin.json().id);
    const memberRow = rows.find((r) => r.record_id === byMember.json().id);
    expect(adminRow, JSON.stringify(rows)).toBeTruthy();
    expect(memberRow, JSON.stringify(rows)).toBeTruthy();
    expect(adminRow!.actor_id).toBe(adminId);
    expect(memberRow!.actor_id).toBe(memberId);
    expect(memberRow!.actor_name).toContain('AuditLogMember');
  });

  it('AC4: filterable by actor', async () => {
    const rec = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Actor filter target' } });
    const log = await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log?actor=${memberId}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ record_id: string; actor_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor_id === memberId)).toBe(true);
    expect(rows.some((r) => r.record_id === rec.json().id)).toBe(true);
  });

  it('AC4: filterable by entity (record)', async () => {
    const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Entity filter target' } });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`, { values: { [titleApiName]: 'Entity filter target (v2)' } });
    // A DIFFERENT record, to prove the filter actually narrows.
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Not this one' } });

    const log = await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log?entity=${rec.json().id}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ record_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.record_id === rec.json().id)).toBe(true);
  });

  it('AC4: filterable by time range — a `from` in the future returns nothing', async () => {
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'x' } });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const log = await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log?from=${encodeURIComponent(future)}`);
    expect(log.statusCode, log.body).toBe(200);
    expect(log.json().data).toEqual([]);
  });

  it('AC6: a removed member still appears as an identifiable actor on their historical entries (the no-FK decision, extended here)', async () => {
    const rec = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Before removal' } });
    expect(rec.statusCode, rec.body).toBe(201);

    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{ id: string; user: { email: string } }>;
    const membership = members.find((m) => m.user.email === member.email)!;
    const removed = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${membership.id}`);
    expect(removed.statusCode, removed.body).toBeLessThan(300);

    const log = await as(admin.token, 'GET', `/workspaces/${wsId}/audit-log?entity=${rec.json().id}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ actor_id: string; actor_name: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actor_id).toBe(memberId);
    expect(rows[0]!.actor_name).toContain('AuditLogMember'); // identifiable, not blank
  });

  it('AC7: access-controlled — a non-admin member cannot reach the audit log', async () => {
    const asMember = await as(member.token, 'GET', `/workspaces/${wsId}/audit-log`);
    expect(asMember.statusCode).toBeGreaterThanOrEqual(400);
    expect(asMember.statusCode).toBeLessThan(500);
  });

  it('MUST KEEP WORKING: existing per-record activity view is unchanged', async () => {
    const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Per-record check' } });
    const activity = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}/activity`);
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.json().data.length).toBeGreaterThan(0);
  });
});
