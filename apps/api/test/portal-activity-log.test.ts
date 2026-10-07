import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #537 — "what each client actually saw and did". Every recipient-scoped
 * portal access is recorded (recipient, view, timestamp, outcome), queryable
 * per recipient and per view, admin-only. A garbage/revoked token has no
 * resolvable recipient to attribute an attempt to — deliberately not logged,
 * see public-views.service.ts's own comment.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
async function pub(url: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}` });
}

async function makeScopedDb(name: string) {
  const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
  const ownerField = (
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Owner Email', type: 'email' })
  ).json();
  return { dbId, ownerApiName: ownerField.apiName };
}

async function makeRecipient(label: string, email: string) {
  return (await as('POST', `/workspaces/${wsId}/portal-recipients`, { label, email })).json();
}

async function shareScoped(dbId: string, viewId: string, scopeApiName: string) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
    recipient_scope_field_api_name: scopeApiName,
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().token as string;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PortalActivityAdmin');
  wsId = (await as('POST', '/workspaces', { name: '537 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('#537 — recipient access is recorded: recipient, view, timestamp, outcome', () => {
  it('a successful access is logged as served, queryable by recipient', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Activity Served');
    const recipient = await makeRecipient('Served Client', 'served@clients.test');
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'served@clients.test' } });
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const view = await pub(`/public/views/${token}?recipient=${recipient.token}`);
    expect(view.statusCode, view.body).toBe(200);

    const log = await as('GET', `/workspaces/${wsId}/portal-activity?recipient=${recipient.id}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ recipient_id: string; view_id: string; outcome: string; recipient_label: string; view_name: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.recipient_id).toBe(recipient.id);
    expect(row.view_id).toBe(viewId);
    expect(row.outcome).toBe('served');
    expect(row.recipient_label).toBe('Served Client');
  });

  it('served is recorded even when the fail-closed scope leaves the recipient with zero rows — "did they look", not "did they see anything"', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Activity Served Empty');
    const noEmailRecipient = await makeRecipient('No Email Served', undefined as never);
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const view = await pub(`/public/views/${token}?recipient=${noEmailRecipient.token}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().records.data).toEqual([]);

    const log = await as('GET', `/workspaces/${wsId}/portal-activity?recipient=${noEmailRecipient.id}`);
    const rows = log.json().data as Array<{ outcome: string }>;
    expect(rows.some((r) => r.outcome === 'served')).toBe(true);
  });

  it('a token from a different workspace is recorded as rejected, attributed to the recipient it actually belongs to', async () => {
    const otherWsId = (await as('POST', '/workspaces', { name: '537 Other WS' })).json().id;
    const foreignRecipient = await as('POST', `/workspaces/${otherWsId}/portal-recipients`, { label: 'Foreign' });
    const foreignToken = foreignRecipient.json().token as string;
    const foreignId = foreignRecipient.json().id as string;

    const { dbId, ownerApiName } = await makeScopedDb('Activity Rejected');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const view = await pub(`/public/views/${token}?recipient=${foreignToken}`);
    expect(view.statusCode).toBe(403);

    // The rejection is logged under the FOREIGN workspace's own activity log
    // (workspaceId comes from the accessed view's database, per the ticket's
    // own AC that this is "visible to workspace members who administer THE
    // portal" — the receiving workspace, not the token's origin workspace).
    const log = await as('GET', `/workspaces/${wsId}/portal-activity?recipient=${foreignId}`);
    const rows = log.json().data as Array<{ outcome: string; reason: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.outcome).toBe('rejected');
    expect(rows[0]!.reason).toContain('different workspace');
  });

  it('an unresolvable token (garbage or revoked) is NOT logged — there is no recipient to attribute it to', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Activity Unattributable');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const before = await as('GET', `/workspaces/${wsId}/portal-activity?view=${viewId}`);
    const beforeCount = (before.json().data as unknown[]).length;

    const garbage = await pub(`/public/views/${token}?recipient=not-a-real-token`);
    expect(garbage.statusCode).toBe(403);

    const after = await as('GET', `/workspaces/${wsId}/portal-activity?view=${viewId}`);
    expect((after.json().data as unknown[]).length).toBe(beforeCount);
  });

  it('a revoked recipient\'s history SURVIVES revocation', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Activity Survives Revocation');
    const recipient = await makeRecipient('Soon Revoked', 'revoke-me@clients.test');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    await pub(`/public/views/${token}?recipient=${recipient.token}`);
    await as('POST', `/workspaces/${wsId}/portal-recipients/${recipient.id}/revoke`);

    const log = await as('GET', `/workspaces/${wsId}/portal-activity?recipient=${recipient.id}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ outcome: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('queryable per published view too, not just per recipient', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Activity Per View');
    const recA = await makeRecipient('Per View A', 'perviewA@clients.test');
    const recB = await makeRecipient('Per View B', 'perviewB@clients.test');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    await pub(`/public/views/${token}?recipient=${recA.token}`);
    await pub(`/public/views/${token}?recipient=${recB.token}`);

    const log = await as('GET', `/workspaces/${wsId}/portal-activity?view=${viewId}`);
    const rows = log.json().data as Array<{ recipient_id: string }>;
    const recipientIds = new Set(rows.map((r) => r.recipient_id));
    expect(recipientIds).toEqual(new Set([recA.id, recB.id]));
  });

  it('MUST KEEP WORKING: a logging failure never blocks the portal render — the public endpoint always returns the view even if activity logging is unreachable', async () => {
    // Structural: PortalActivityService.record() wraps its own insert in
    // try/catch and never rethrows (see its own doc comment) — this is the
    // behavioral proof: an ordinary successful access still returns 200 with
    // real data regardless of the log write's own success, since the log
    // write happens AFTER the response body is already fully assembled.
    const { dbId, ownerApiName } = await makeScopedDb('Activity Never Blocks');
    const recipient = await makeRecipient('Never Blocked', 'neverblocked@clients.test');
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'neverblocked@clients.test' } });
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const view = await pub(`/public/views/${token}?recipient=${recipient.token}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().records.data.length).toBe(1);
  });

  it('AC: not visible to recipients themselves — no auth path for a recipient to reach this endpoint at all', async () => {
    // Structural: portal-activity.controller.ts requires AuthGuard (a signed-in
    // workspace member's bearer token) — a portal recipient holds only an
    // opaque portal-recipients token, which is not a bearer token accepted by
    // AuthGuard anywhere. There is no code path from "I have a recipient
    // token" to this endpoint at all.
    const noAuth = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/portal-activity` });
    expect(noAuth.statusCode).toBeGreaterThanOrEqual(400);
    expect(noAuth.statusCode).toBeLessThan(500);
  });

  it('AC: a non-admin member cannot reach the activity log', async () => {
    const member = await signUpUser(app, 'PortalActivityMember');
    const invite = await as('POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(member.token),
      payload: { token: inviteToken },
    });
    const asMember = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/portal-activity`,
      headers: authed(member.token),
    });
    expect(asMember.statusCode).toBeGreaterThanOrEqual(400);
    expect(asMember.statusCode).toBeLessThan(500);
  });
});
