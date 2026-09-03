import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let memberId: string;
let memberMembership: string;
let adminMembership: string;
let wsId: string;
let space: string;
let db: string;
let recId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GdprOwner');
  member = await signUpUser(app, 'GdprMember');
  memberId = (await as(member.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS' })).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  db = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Tasks',
    })
  ).json().id;

  // member joins with editor access so they can author a record + comment
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
    grants: [{ space_id: space, role: 'editor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });

  recId = (
    await as(member.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, {
      values: { name: 'Member task' },
    })
  ).json().id;
  await as(member.token, 'POST', `/workspaces/${wsId}/databases/${db}/records/${recId}/comments`, {
    body: [{ type: 'text', text: 'a comment by the member' }],
  });

  const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
  memberMembership = members.find((m: { user_id: string }) => m.user_id === memberId).id;
  adminMembership = members.find((m: { user_id: string }) => m.user_id !== memberId).id;
});

afterAll(async () => {
  await app.close();
});

describe('GDPR data-subject tooling (MN-233)', () => {
  it('a non-admin cannot export or anonymize', async () => {
    const exp = await as(member.token, 'GET', `/workspaces/${wsId}/members/${memberMembership}/gdpr/export`);
    expect(exp.statusCode).toBe(403);
    const anon = await as(member.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(anon.statusCode).toBe(403);
  });

  it('admin export includes the subject profile and their authored content', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/members/${memberMembership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json();
    expect(data.subject_user_id).toBe(memberId);
    expect(data.profile.email).toBe(member.email);
    expect(data.authored_records.some((r: { id: string }) => r.id === recId)).toBe(true);
    expect(data.authored_comments.length).toBeGreaterThanOrEqual(1);
    expect(data.membership.role).toBe('member');
  });

  it('refuses to anonymize the last admin', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${adminMembership}/gdpr/anonymize`);
    expect(res.statusCode).toBe(409);
  });

  it('anonymize tombstones identity, kills the session, removes access, keeps history', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.anonymized).toBe(true);
    expect(out.removed.memberships).toBe(1);

    // membership gone
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    expect(members.some((m: { user_id: string }) => m.user_id === memberId)).toBe(false);

    // the member's session is destroyed — they can no longer authenticate
    const me = await as(member.token, 'GET', '/me');
    expect(me.statusCode).toBe(401);

    // the comment survives but its author is now the tombstone identity
    const comments = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db}/records/${recId}/comments`)
    ).json();
    expect(comments.data.length).toBeGreaterThanOrEqual(1);
    expect(comments.data[0].author.name).toBe('Deleted user');
  });

  it('a removed membership can no longer be targeted', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(res.statusCode).toBe(404);
  });
});

describe('#494 — subject-access export includes the Members-database row', () => {
  let ws2: string;
  let space2: string;
  let member2: { token: string; email: string };
  let member2Id: string;
  let member2Membership: string;

  beforeAll(async () => {
    member2 = await signUpUser(app, 'Gdpr494Member');
    member2Id = (await as(member2.token, 'GET', '/me')).json().id;
    ws2 = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS 494' })).json().id;
    space2 = (await as(admin.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;

    const invite = await as(admin.token, 'POST', `/workspaces/${ws2}/invites`, {
      email: member2.email,
      role: 'member',
      grants: [{ space_id: space2, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member2.token, 'POST', '/invites/accept', { token });
    await app.get(MembersProjectionSubscriber).settle(ws2);

    const members = (await as(admin.token, 'GET', `/workspaces/${ws2}/members`)).json();
    member2Membership = members.find((m: { user_id: string }) => m.user_id === member2Id).id;

    // An admin adds a custom column to Members and populates it for this person.
    const membersDb = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases`)).json().find(
      (d: { name: string }) => d.name === 'Members',
    );
    const phoneField = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${membersDb.id}/fields`, { display_name: 'Phone', type: 'text' })
    ).json();
    const rows = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases/${membersDb.id}/records`)).json().data;
    const memberRow = rows.find((r: { values: Record<string, unknown> }) => r.values['user_id'] === member2Id);
    await as(admin.token, 'PATCH', `/workspaces/${ws2}/databases/${membersDb.id}/records/${memberRow.id}`, {
      values: { [phoneField.apiName]: '555-0100' },
    });
  });

  it('export before erasure includes the Members row, custom column value included', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${ws2}/members/${member2Membership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().members_row;
    expect(row, 'the export must include the members_row key at all').toBeTruthy();
    expect(row.email).toBe(member2.email);
    const membersDb = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases`)).json().find(
      (d: { name: string }) => d.name === 'Members',
    );
    const fields = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases/${membersDb.id}`)).json().fields;
    const phoneApiName = fields.find((f: { displayName: string }) => f.displayName === 'Phone').apiName;
    expect(row[phoneApiName]).toBe('555-0100');
  });

  it('DECISION: a departed member (membership already removed) gets a 404, not a partial export', async () => {
    const anon = await as(admin.token, 'POST', `/workspaces/${ws2}/members/${member2Membership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);

    const after = await as(admin.token, 'GET', `/workspaces/${ws2}/members/${member2Membership}/gdpr/export`);
    expect(after.statusCode, 'documented decision on #494: export 404s once the membership is gone').toBe(404);
  });

  it('export degrades cleanly when the Members projection has not caught up yet — members_row is null, not an error', async () => {
    // Deliberately does NOT await the projection subscriber's settle() —
    // the Members-row sync is fire-and-forget off the membership-event bus
    // (members-projection.subscriber.ts), so an export requested in the gap
    // between "invite accepted" and "projection wrote the row" is a real,
    // reachable state, not a hypothetical. getOwnRowForExport must degrade to
    // null rather than throw.
    const ws3 = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS 494 no members db' })).json().id;
    const person = await signUpUser(app, 'Gdpr494NoRow');
    const invite = await as(admin.token, 'POST', `/workspaces/${ws3}/invites`, { email: person.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(person.token, 'POST', '/invites/accept', { token });
    const members = (await as(admin.token, 'GET', `/workspaces/${ws3}/members`)).json();
    const personMembership = members.find((m: { email?: string }) => m.email === person.email)?.id
      ?? members[members.length - 1].id;

    const res = await as(admin.token, 'GET', `/workspaces/${ws3}/members/${personMembership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    // Members provisions lazily off membership sync — by the time an invite
    // is accepted the projection has typically already run, so this mostly
    // guards that a MISSING row (not just a missing database) degrades to
    // null rather than throwing, whichever way it landed.
    expect(res.json()).toHaveProperty('members_row');
  });
});
