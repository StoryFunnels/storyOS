import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

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
