/**
 * #690 — `NotificationsService.notify()` never checked whether a recipient
 * could actually see the triggering record/database before enqueueing a
 * notification (and storing its `snippet`, readable forever via
 * GET /notifications). THIS IS A SECURITY BOUNDARY, so — per this session's
 * own recurring lesson — every assertion here uses a real guest with a real
 * grant, never just a member sanity check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { notifications } from '../src/db/schema';

const { db } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let hiddenDbId: string;
let visibleDbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function mention(dbId: string, recordId: string, userId: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`, {
    body: [{ type: 'text', text: 'ping ' }, { type: 'mention', user_id: userId }],
  });
}

/**
 * A guest cannot be @-mentioned at all ("not a mentionable member" — a
 * separate validation rule, unrelated to #690), so the guest-recipient
 * tests below exercise the same notify() access-check path via assignment
 * instead. Both producers call notify() with the same {databaseId,
 * recordId} shape this ticket's fix gates on.
 */
async function assign(dbId: string, recordId: string, userId: string) {
  const field = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: `Owner${Math.random().toString(36).slice(2, 8)}`, type: 'user', config: {},
  })).json();
  return as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
    values: { [field.apiName]: userId },
  });
}

async function inviteGuest(name: string, grants: Array<{ database_id: string; role: string }>) {
  const guest = await signUpUser(app, name);
  const guestId = (await as(guest.token, 'GET', '/me')).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: guest.email, role: 'guest', grants });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  return { ...guest, id: guestId as string };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'NotifyAccessOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '690 WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  hiddenDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Hidden690' })).json().id;
  visibleDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Visible690' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#690 notify() access check', () => {
  it('ADVERSARIAL: a guest with NO grant on the record\'s database gets no notification and no stored snippet', async () => {
    const guest = await inviteGuest('NotifyGuestHidden', [{ database_id: visibleDbId, role: 'viewer' }]);
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${hiddenDbId}/records`, { values: { name: 'Secret' } })).json();

    const res = await assign(hiddenDbId, rec.id, guest.id);
    expect(res.statusCode, res.body).toBeLessThan(300);

    const count = (await as(guest.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(count.count).toBe(0);
    const list = (await as(guest.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(list.data.some((n: { type: string }) => n.type === 'assigned')).toBe(false);

    // Stronger than the API-level check above: no row exists at all, not
    // merely one that's filtered out of the list response — there is no
    // stored snippet sitting in the table waiting for a future grant to
    // surface it.
    const rows = await db.query.notifications.findMany({ where: eq(notifications.recordId, rec.id) });
    expect(rows, 'no notification row should exist for a recipient with no access').toHaveLength(0);
  });

  it('MUST KEEP WORKING: a guest WITH a grant on the record\'s database is still notified normally', async () => {
    const guest = await inviteGuest('NotifyGuestVisible', [{ database_id: visibleDbId, role: 'viewer' }]);
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${visibleDbId}/records`, { values: { name: 'Public' } })).json();

    const res = await assign(visibleDbId, rec.id, guest.id);
    expect(res.statusCode, res.body).toBeLessThan(300);

    const count = (await as(guest.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(count.count).toBe(1);
    const list = (await as(guest.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(list.data.some((n: { type: string }) => n.type === 'assigned')).toBe(true);
  });

  it('MUST KEEP WORKING: an unrestricted admin/member is unaffected by the access check', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${hiddenDbId}/records`, { values: { name: 'Own record' } })).json();
    const member = await signUpUser(app, 'NotifyMember690');
    const memberId = (await as(member.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member.token, 'POST', '/invites/accept', { token });

    const res = await mention(hiddenDbId, rec.id, memberId);
    expect(res.statusCode, res.body).toBeLessThan(300);
    const count = (await as(member.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(count.count).toBe(1);
  });
});
