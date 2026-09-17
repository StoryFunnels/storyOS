import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * #730 — `notify_user` could only target `@me` or a person field on the
 * triggering record; there was no way to notify a specific NAMED workspace
 * member. Adds `@member:<userId>`, validated server-side against actual,
 * ACTIVE workspace membership (a non-member or removed member's id is
 * rejected, not silently accepted).
 */
let app: NestFastifyApplication;
let engine: AutomationsService;
let admin: { token: string; email: string };
let targetMember: { token: string; email: string; id: string; membershipId: string };
let outsider: { token: string; email: string };
let wsId: string;
let dbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  admin = await signUpUser(app, 'NotifyTargetOwner');
  outsider = await signUpUser(app, 'NotifyTargetOutsider');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '730 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Applications' })).json().id;

  const memberUser = await signUpUser(app, 'NotifyTargetMember');
  const memberId = (await as(memberUser.token, 'GET', '/me')).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: memberUser.email, role: 'member' });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(memberUser.token, 'POST', '/invites/accept', { token });
  const membershipRow = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json().find(
    (m: { user_id: string }) => m.user_id === memberId,
  );
  targetMember = { ...memberUser, id: memberId, membershipId: membershipRow.id };
});

afterAll(async () => {
  await app.close();
});

describe('#730 — notify_user targets a specific workspace member (@member:<id>)', () => {
  it('accepts an active member as a notify_user target on a non-webhook rule', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify Daria',
      trigger: { type: 'record_created' },
      actions: [{ type: 'notify_user', user: `@member:${targetMember.id}`, message: 'New application: {Name}' }],
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('rejects a user id that was never a member of this workspace', async () => {
    const outsiderId = (await as(outsider.token, 'GET', '/me')).json().id;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify a stranger',
      trigger: { type: 'record_created' },
      actions: [{ type: 'notify_user', user: `@member:${outsiderId}`, message: 'hi' }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/not an active member/);
  });

  it('rejects a REMOVED member\'s id — a stale target does not silently pass validation', async () => {
    const removedUser = await signUpUser(app, 'NotifyTargetRemoved');
    const removedId = (await as(removedUser.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: removedUser.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(removedUser.token, 'POST', '/invites/accept', { token });
    const membershipRow = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json().find(
      (m: { user_id: string }) => m.user_id === removedId,
    );
    const removeRes = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${membershipRow.id}`);
    expect(removeRes.statusCode, removeRes.body).toBeLessThan(300);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify a removed member',
      trigger: { type: 'record_created' },
      actions: [{ type: 'notify_user', user: `@member:${removedId}`, message: 'hi' }],
    });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('MUST KEEP WORKING: a webhook_received rule still refuses any non-@me target, including a member target', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Webhook notify',
      trigger: { type: 'webhook_received' },
      actions: [{ type: 'notify_user', user: `@member:${targetMember.id}`, message: 'hi' }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/only notify "@me"/);
  });

  it('MUST KEEP WORKING: @me and a person field still validate exactly as before', async () => {
    const okMe = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify me',
      trigger: { type: 'record_created' },
      actions: [{ type: 'notify_user', user: '@me', message: 'hi' }],
    });
    expect(okMe.statusCode, okMe.body).toBe(201);

    const badField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify a non-person field',
      trigger: { type: 'record_created' },
      actions: [{ type: 'notify_user', user: 'name', message: 'hi' }],
    });
    expect(badField.statusCode, badField.body).toBe(422);
    expect(badField.json().error.message).toMatch(/must be @me, @member:<id>, or a person field/);
  });

  it('LIVE: triggering the rule actually notifies the named member — not the actor, not a person field', async () => {
    const rule = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Live notify Daria',
        trigger: { type: 'record_created' },
        actions: [{ type: 'notify_user', user: `@member:${targetMember.id}`, message: 'New application: {Name}' }],
      })
    ).json();
    expect(rule.enabled).toBe(true);

    const beforeCount = (await as(targetMember.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();

    const record = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Jamie Rivera' },
    });
    expect(record.statusCode, record.body).toBeLessThan(300);
    // The rule fires off the after-commit domain event, chained per-record and
    // NOT awaited by the create() response — settle() is the test hook every
    // other automations test in this suite uses to wait for that chain.
    await engine.settle(record.json().id);

    const afterCount = (await as(targetMember.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(afterCount.count).toBe(beforeCount.count + 1);

    const list = (await as(targetMember.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    const note = list.data.find((n: { snippet: string }) => n.snippet?.includes('Jamie Rivera'));
    expect(note, JSON.stringify(list.data)).toBeTruthy();

    // The admin (rule owner/actor) was NOT notified — this must not fall back
    // to '@me' semantics.
    const adminCount = (await as(admin.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    const adminList = (await as(admin.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(adminList.data.some((n: { snippet: string }) => n.snippet?.includes('Jamie Rivera') && n.type === 'mentioned')).toBe(false);
    void adminCount;
  });
});
