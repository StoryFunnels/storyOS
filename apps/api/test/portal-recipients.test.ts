import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AccessService } from '../src/access/access.service';
import { PortalRecipientsService } from '../src/portal/portal-recipients.service';

/**
 * #534 — the foundation ticket for the portal epic (#19). Identity and
 * lifecycle ONLY: a recipient is a named external party who can be given
 * access to published content without a user account, an invitation, or a
 * billable seat. Row scoping, magic-link delivery, branding, write-back,
 * activity logging and entitlement are all filed separately and are
 * deliberately not touched here.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let access: AccessService;
let recipients: PortalRecipientsService;
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  access = app.get(AccessService);
  recipients = app.get(PortalRecipientsService);
  admin = await signUpUser(app, 'PortalOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Portal WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#534 portal recipients — identity and lifecycle', () => {
  it('AC1: a recipient can be created with a label and no email, creates no user, sends no invite, and does not change billableSeats', async () => {
    const before = await access.billableUserIds(wsId);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Acme Corp' });
    expect(res.statusCode, res.body).toBe(201);
    const recipient = res.json();
    expect(recipient.label).toBe('Acme Corp');
    expect(recipient.email).toBeNull();
    expect(recipient.revoked_at ?? recipient.revokedAt).toBeNull();

    const after = await access.billableUserIds(wsId);
    expect(after).toEqual(before);
  });

  it('AC2: creating 50 recipients in one workspace changes no seat count', async () => {
    const before = await access.billableUserIds(wsId);
    for (let i = 0; i < 50; i++) {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients`, { label: `Client ${i}` });
      expect(res.statusCode, res.body).toBe(201);
    }
    const after = await access.billableUserIds(wsId);
    expect(after).toEqual(before);

    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/portal-recipients`);
    expect(list.json().length).toBeGreaterThanOrEqual(50);
  });

  it('AC3: the token is opaque and not derived from label, id, or creation time', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Token Check Co' });
    const r = res.json();
    expect(r.token).not.toContain('Token Check Co');
    expect(r.token).not.toContain(r.id);
    // A base64url random token of 24 bytes decodes to 32 chars; nothing about
    // it should resemble an ISO timestamp or the label/id above.
    expect(r.token.length).toBeGreaterThan(20);
  });

  it('AC4: revoking closes access IMMEDIATELY — a resolver call after revoke rejects even though the token itself never changed', async () => {
    const created = (await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Revoke Me' })).json();

    // "Holding an open session": resolve once successfully before revoking.
    const before = await recipients.resolveByToken(created.token);
    expect(before.id).toBe(created.id);

    const revokeRes = await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients/${created.id}/revoke`);
    expect(revokeRes.statusCode, revokeRes.body).toBeLessThan(300);

    // Same token, no cache, no wait — must reject on the very next call.
    await expect(recipients.resolveByToken(created.token)).rejects.toThrow();
  });

  it('AC5: recipients are listable and countable per workspace', async () => {
    const otherWs = (await as(admin.token, 'POST', '/workspaces', { name: 'Other Portal WS' })).json().id;
    await as(admin.token, 'POST', `/workspaces/${otherWs}/portal-recipients`, { label: 'Only In Other WS' });

    const list = await as(admin.token, 'GET', `/workspaces/${otherWs}/portal-recipients`);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].label).toBe('Only In Other WS');

    const count = await recipients.count(otherWs);
    expect(count).toBe(1);
  });

  it('MUST KEEP WORKING: guest tier (#238) seat accounting is untouched by recipients existing', async () => {
    const guest = await signUpUser(app, 'PortalGuestCheck');
    const guestId = (await as(guest.token, 'GET', '/me')).json().id;
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const bystanderDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Bystander' })).json().id;

    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ database_id: bystanderDb, role: 'contributor' }],
    });
    const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token: inviteToken });

    const billable = await access.billableUserIds(wsId);
    expect(billable).toContain(guestId);
  });

  it('AC6/decision: recipients are a first-class table, not a user-visible database — see schema.ts:portalRecipients doc comment', async () => {
    // Structural assertion standing in for the written decision: a recipient
    // is reachable only through this API, never through a database/records
    // endpoint. There is no databaseId anywhere on the entity.
    const created = (await as(admin.token, 'POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Structural Check' })).json();
    expect(created).not.toHaveProperty('database_id');
    expect(created).not.toHaveProperty('databaseId');
  });
});
