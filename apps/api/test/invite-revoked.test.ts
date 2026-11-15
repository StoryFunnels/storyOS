import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { invites } from '../src/db/schema';
import { EmailService } from '../src/mail/email.service';
import { ActivationService } from '../src/workspaces/activation.service';
import { InvitesService, REVOKED_INVITE_RETENTION_MS } from '../src/workspaces/invites.service';

/**
 * Ticket #1304 — a revoke keeps a tombstone (`revoked_at`, inviter retained) so the invite link can say "revoked, ask <inviter>"
 * instead of reading as a link that never existed. The tombstone is a NEW readable state, so everything that reads invites is
 * under test twice: the details read must show it, and every other reader (list, count, resend, accept, re-invite, purge) must
 * keep ignoring it exactly as it ignored the deleted row.
 */
let app: NestFastifyApplication;
let db: Db;
let invitesService: InvitesService;

const PASSWORD = 'test-password-123';
let seq = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  invitesService = app.get(InvitesService);
  vi.spyOn(app.get(EmailService), 'send').mockResolvedValue(undefined as never);
}, 120_000);
afterAll(async () => {
  await app.close();
});

const call = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });

async function signUpAs(email: string, name = 'Invited Person') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-up/email', payload: { email, password: PASSWORD, name } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-auth-token']);
}

/** An admin with a workspace, and an invite for `email`. */
async function inviteSomeone(email: string, opts: { inviterName?: string; role?: 'member' | 'guest' } = {}) {
  const owner = await signUpUser(app, opts.inviterName ?? 'Inviter Iris');
  const ws = (await call(owner.token, 'POST', '/workspaces', { name: `Pinewood ${unique('ws')}` })).json() as { id: string; name: string };
  const created = await invite(owner.token, ws.id, email, opts.role);
  return { owner, ws, ...created };
}
async function invite(ownerToken: string, wsId: string, email: string, role: 'member' | 'guest' = 'member') {
  let payload: Record<string, unknown> = { email, role };
  if (role === 'guest') {
    const spaces = (await call(ownerToken, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{ id: string }>;
    payload = { ...payload, grants: [{ space_id: spaces[0]!.id, role: 'viewer' }] };
  }
  const inv = await call(ownerToken, 'POST', `/workspaces/${wsId}/invites`, payload);
  expect(inv.statusCode, inv.body).toBe(201);
  const body = inv.json() as { id: string; accept_url: string };
  return { inviteId: body.id, token: new URL(body.accept_url).searchParams.get('token')! };
}
const revoke = (ownerToken: string, wsId: string, inviteId: string) => call(ownerToken, 'DELETE', `/workspaces/${wsId}/invites/${inviteId}`);
const details = (token: string) => call(null, 'GET', `/public/invites/details?token=${encodeURIComponent(token)}`);
const pending = async (ownerToken: string, wsId: string) => (await call(ownerToken, 'GET', `/workspaces/${wsId}/invites`)).json() as Array<{ id: string; email: string }>;
const myWorkspaces = async (token: string) => (await call(token, 'GET', '/workspaces')).json() as Array<{ id: string }>;
const row = (id: string) => db.query.invites.findFirst({ where: eq(invites.id, id) });

const NOT_FOUND = { status: 'not_found', inviter_name: null, workspace_name: null, workspace_logo_url: null, invited_email: null };

describe('revoking keeps a tombstone', () => {
  it('sets revoked_at on the SAME row (token hash and inviter retained) instead of deleting it', async () => {
    const email = `${unique('keep')}@test.storyos.dev`;
    const { owner, ws, inviteId } = await inviteSomeone(email);
    const before = (await row(inviteId))!;
    expect(before.revokedAt).toBeNull();

    const res = await revoke(owner.token, ws.id, inviteId);
    expect(res.statusCode, res.body).toBe(200);

    const after = (await row(inviteId))!;
    expect(after, 'the row is still there').toBeDefined();
    expect(after.revokedAt).toBeInstanceOf(Date);
    expect(after.invitedBy, 'the inviter is what the screen names').toBe(before.invitedBy);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.acceptedAt).toBeNull();
  });

  it('revoking twice, an unknown id, and another workspace\'s invite are all 404 (and the other workspace\'s stays live)', async () => {
    const a = await inviteSomeone(`${unique('a')}@test.storyos.dev`);
    expect((await revoke(a.owner.token, a.ws.id, a.inviteId)).statusCode).toBe(200);
    expect((await revoke(a.owner.token, a.ws.id, a.inviteId)).statusCode, 'second revoke').toBe(404);
    expect((await revoke(a.owner.token, a.ws.id, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);

    const b = await inviteSomeone(`${unique('b')}@test.storyos.dev`);
    expect((await revoke(a.owner.token, a.ws.id, b.inviteId)).statusCode, 'cross-workspace').toBe(404);
    expect((await row(b.inviteId))!.revokedAt, 'not revoked by the foreign admin').toBeNull();
    expect((await details(b.token)).json().status).toBe('valid');
  });

  it('an ACCEPTED invite cannot be revoked: it stays used, never reads as revoked', async () => {
    const email = `${unique('used')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email);
    const person = await signUpAs(email);
    expect((await call(person, 'POST', '/invites/accept', { token })).statusCode).toBe(201);

    expect((await revoke(owner.token, ws.id, inviteId)).statusCode).toBe(404);
    expect((await row(inviteId))!.revokedAt).toBeNull();
    expect((await details(token)).json().status).toBe('used');
  });
});

describe('GET /public/invites/details for a revoked token', () => {
  it('reads status revoked with the inviter, workspace and invited address, like expired and used, and the SAME five keys', async () => {
    const email = `${unique('rev')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email, { inviterName: 'Ingrid Inviter' });
    await revoke(owner.token, ws.id, inviteId);

    const res = await details(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.json()).sort()).toEqual(['invited_email', 'inviter_name', 'status', 'workspace_logo_url', 'workspace_name']);
    expect(res.json()).toEqual({
      status: 'revoked',
      inviter_name: 'Ingrid Inviter',
      workspace_name: ws.name,
      workspace_logo_url: null,
      invited_email: email,
    });
    // The same things stay off the wire as for every other status.
    for (const secret of [token, inviteId, ws.id, owner.email]) expect(res.body).not.toContain(secret);
    expect(res.body).not.toMatch(/[0-9a-f]{64}/);
  });

  it('a revoked token and an unknown token DIFFER only as specified: status and the three named fields; unknown is still the one neutral body', async () => {
    const { owner, ws, inviteId, token } = await inviteSomeone(`${unique('diff')}@test.storyos.dev`, { inviterName: 'Ingrid Inviter' });
    await revoke(owner.token, ws.id, inviteId);
    const revoked = (await details(token)).json() as Record<string, unknown>;
    const unknown = (await details('Q'.repeat(32))).json() as Record<string, unknown>;

    expect(unknown).toEqual(NOT_FOUND);
    const differing = Object.keys(revoked).filter((k) => revoked[k] !== unknown[k]).sort();
    expect(differing).toEqual(['invited_email', 'inviter_name', 'status', 'workspace_name']);
    // malformed shapes are still the neutral body, not a faster/different answer
    for (const bad of ['', 'x', 'z'.repeat(10_000)]) expect((await details(bad)).json(), JSON.stringify(bad).slice(0, 12)).toEqual(NOT_FOUND);
  });

  it('revoked wins over expired: a link revoked AND past its date says revoked', async () => {
    const { owner, ws, inviteId, token } = await inviteSomeone(`${unique('both')}@test.storyos.dev`);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, inviteId));
    await revoke(owner.token, ws.id, inviteId);
    expect((await details(token)).json().status).toBe('revoked');
  });

  it('a revoked row whose inviter account is gone still reads revoked with inviter_name null (no crash, no guess)', async () => {
    const { owner, ws, inviteId, token } = await inviteSomeone(`${unique('noinv')}@test.storyos.dev`);
    await revoke(owner.token, ws.id, inviteId);
    await db.update(invites).set({ invitedBy: null }).where(eq(invites.id, inviteId));
    expect((await details(token)).json()).toMatchObject({ status: 'revoked', inviter_name: null, workspace_name: ws.name });
  });

  it('KEPT: valid, used and expired read exactly as before', async () => {
    const email = `${unique('kept')}@test.storyos.dev`;
    const live = await inviteSomeone(email, { inviterName: 'Ingrid Inviter' });
    expect((await details(live.token)).json()).toMatchObject({ status: 'valid', inviter_name: 'Ingrid Inviter', invited_email: email });

    const person = await signUpAs(email);
    await call(person, 'POST', '/invites/accept', { token: live.token });
    expect((await details(live.token)).json().status).toBe('used');

    const stale = await inviteSomeone(`${unique('stale')}@test.storyos.dev`);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, stale.inviteId));
    expect((await details(stale.token)).json().status).toBe('expired');
  });
});

describe('a revoked token is REFUSED on every accept path, with its own stable code', () => {
  it('POST /invites/accept and POST /workspaces {invite_token}: 404 invite_revoked, nothing joined, nothing created, token never echoed', async () => {
    const email = `${unique('refuse')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email);
    await revoke(owner.token, ws.id, inviteId);
    const person = await signUpAs(email);

    const viaAccept = await call(person, 'POST', '/invites/accept', { token });
    expect(viaAccept.statusCode, viaAccept.body).toBe(404);
    expect(viaAccept.json().error?.code ?? viaAccept.json().code).toBe('invite_revoked');

    const viaCreate = await call(person, 'POST', '/workspaces', { name: 'Should Not Exist', invite_token: token });
    expect(viaCreate.statusCode, viaCreate.body).toBe(404);
    expect(viaCreate.json().error?.code ?? viaCreate.json().code).toBe('invite_revoked');

    for (const res of [viaAccept, viaCreate]) expect(res.body).not.toContain(token);
    expect(await myWorkspaces(person), 'joined nothing and created nothing').toEqual([]);
    expect((await row(inviteId))!.acceptedAt, 'the tombstone was not consumed').toBeNull();
  });

  it('refuses it even for the wrong address: the revoked code never depends on who asks, and a wrong-address caller learns nothing more', async () => {
    const { owner, ws, inviteId, token } = await inviteSomeone(`${unique('rightful')}@test.storyos.dev`);
    await revoke(owner.token, ws.id, inviteId);
    const stranger = await signUpAs(`${unique('stranger')}@test.storyos.dev`);
    const res = await call(stranger, 'POST', '/invites/accept', { token });
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code ?? res.json().code).toBe('invite_revoked');
    expect(await myWorkspaces(stranger)).toEqual([]);
  });

  it('a revoked link that has also passed its date is refused as revoked, not expired', async () => {
    const email = `${unique('bothrefuse')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, inviteId));
    await revoke(owner.token, ws.id, inviteId);
    const person = await signUpAs(email);
    const res = await call(person, 'POST', '/invites/accept', { token });
    expect(res.json().error?.code ?? res.json().code).toBe('invite_revoked');
  });

  it('a revoke that lands AFTER accept read the invite still wins: refused as invite_revoked, and the membership insert is rolled back', async () => {
    const email = `${unique('race')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email);
    const stale = (await row(inviteId))!; // what accept() would have read a moment before the revoke
    await revoke(owner.token, ws.id, inviteId);
    const personToken = await signUpAs(email);
    const me = (await call(personToken, 'GET', '/me')).json() as { id: string; email: string };

    const spy = vi.spyOn(db.query.invites, 'findFirst').mockResolvedValueOnce(stale);
    try {
      await expect(invitesService.accept({ id: me.id, email: me.email } as never, token)).rejects.toMatchObject({ status: 404 });
    } finally {
      spy.mockRestore();
    }
    expect(await myWorkspaces(personToken), 'rolled back: no membership').toEqual([]);
    expect((await row(inviteId))!.acceptedAt).toBeNull();
  });

  it('KEPT: unknown stays invite_not_found, expired stays invite_expired, wrong address stays 403', async () => {
    const email = `${unique('kept-refuse')}@test.storyos.dev`;
    const person = await signUpAs(email);
    const code = (r: { json: () => { error?: { code?: string }; code?: string } }) => r.json().error?.code ?? r.json().code;

    const unknown = await call(person, 'POST', '/invites/accept', { token: 'N'.repeat(32) });
    expect([unknown.statusCode, code(unknown)]).toEqual([404, 'invite_not_found']);

    const expired = await inviteSomeone(email);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.inviteId));
    const exp = await call(person, 'POST', '/invites/accept', { token: expired.token });
    expect([exp.statusCode, code(exp)]).toEqual([404, 'invite_expired']);

    const other = await inviteSomeone(`${unique('else')}@test.storyos.dev`);
    const mismatch = await call(person, 'POST', '/invites/accept', { token: other.token });
    expect([mismatch.statusCode, code(mismatch)]).toEqual([403, 'invite_email_mismatch']);
  });

  it('KEPT: an invite that was NOT revoked still accepts (the tombstone check does not refuse the living)', async () => {
    const email = `${unique('live')}@test.storyos.dev`;
    const { token, ws } = await inviteSomeone(email);
    const person = await signUpAs(email);
    const res = await call(person, 'POST', '/workspaces', { invite_token: token });
    expect(res.statusCode, res.body).toBe(201);
    expect((await myWorkspaces(person)).map((w) => w.id)).toEqual([ws.id]);
  });
});

describe('a revoked invite is not pending anywhere', () => {
  it('is not listed, and cannot be resent (404)', async () => {
    const { owner, ws, inviteId } = await inviteSomeone(`${unique('list')}@test.storyos.dev`);
    expect((await pending(owner.token, ws.id)).map((i) => i.id)).toEqual([inviteId]);
    await revoke(owner.token, ws.id, inviteId);
    expect(await pending(owner.token, ws.id)).toEqual([]);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 10 * 60_000) }).where(eq(invites.id, inviteId));
    expect((await call(owner.token, 'POST', `/workspaces/${ws.id}/invites/${inviteId}/resend`)).statusCode).toBe(404);
    expect((await row(inviteId))!.revokedAt, 'a refused resend does not un-revoke').not.toBeNull();
  });

  it('does not count as "a teammate was invited" (activation), and a PENDING invite still does', async () => {
    const activation = app.get(ActivationService);
    const { owner, ws, inviteId } = await inviteSomeone(`${unique('act')}@test.storyos.dev`);
    expect(await activation.teammateInvited(ws.id), 'a pending invite counts').toBe(true);
    await revoke(owner.token, ws.id, inviteId);
    expect(await activation.teammateInvited(ws.id), 'a revoked one does not').toBe(false);
  });
});

describe('inviting the same address again after a revoke', () => {
  it('issues a fresh valid invite: a NEW row, the old link stays revoked, only the new one is pending and accepts', async () => {
    const email = `${unique('again')}@test.storyos.dev`;
    const { owner, ws, inviteId, token } = await inviteSomeone(email, { inviterName: 'Ingrid Inviter' });
    await revoke(owner.token, ws.id, inviteId);

    const second = await invite(owner.token, ws.id, email);
    expect(second.inviteId, 'a new row, the tombstone is not reused or revived').not.toBe(inviteId);
    expect(second.token).not.toBe(token);

    expect((await row(inviteId))!.revokedAt, 'the first stays revoked').not.toBeNull();
    expect((await details(token)).json().status).toBe('revoked');
    expect((await details(second.token)).json()).toMatchObject({ status: 'valid', inviter_name: 'Ingrid Inviter', invited_email: email });
    expect((await pending(owner.token, ws.id)).map((i) => i.id)).toEqual([second.inviteId]);

    const person = await signUpAs(email);
    expect((await call(person, 'POST', '/invites/accept', { token })).statusCode, 'old link refused').toBe(404);
    expect((await call(person, 'POST', '/invites/accept', { token: second.token })).statusCode, 'new link accepted').toBe(201);
  });

  it('KEPT: re-inviting a PENDING address still refreshes that row (no duplicate rows), and a revoked tombstone alongside it is left alone', async () => {
    const email = `${unique('refresh')}@test.storyos.dev`;
    const { owner, ws, inviteId } = await inviteSomeone(email);
    await revoke(owner.token, ws.id, inviteId);
    const second = await invite(owner.token, ws.id, email);
    const third = await invite(owner.token, ws.id, email);
    expect(third.inviteId, 'refreshed in place').toBe(second.inviteId);
    const all = await db.query.invites.findMany({ where: and(eq(invites.workspaceId, ws.id), eq(invites.email, email)) });
    expect(all.map((r) => r.id).sort()).toEqual([inviteId, second.inviteId].sort());
  });

  it('revoked invites do not eat the seat cap: a Free workspace can revoke and re-invite its second seat any number of times', async () => {
    const { owner, ws, inviteId } = await inviteSomeone(`${unique('cap')}@test.storyos.dev`);
    await revoke(owner.token, ws.id, inviteId);
    for (let i = 0; i < 3; i++) {
      const created = await invite(owner.token, ws.id, `${unique('cap')}@test.storyos.dev`);
      await revoke(owner.token, ws.id, created.inviteId);
    }
    const last = await call(owner.token, 'POST', `/workspaces/${ws.id}/invites`, { email: `${unique('cap')}@test.storyos.dev`, role: 'member' });
    expect(last.statusCode, last.body).toBe(201);
  });
});

describe('tombstone retention', () => {
  it('purgeRevoked deletes a tombstone older than the retention window and nothing else', async () => {
    const owner = await signUpUser(app, 'Purge Owner');
    const ws = (await call(owner.token, 'POST', '/workspaces', { name: `Purge ${unique('ws')}` })).json() as { id: string };
    const mk = async (label: string) => (await invite(owner.token, ws.id, `${unique(label)}@test.storyos.dev`)).inviteId;
    const longAgo = new Date(Date.now() - REVOKED_INVITE_RETENTION_MS - DAY_MS);
    const recent = new Date(Date.now() - REVOKED_INVITE_RETENTION_MS + DAY_MS);

    const oldRevoked = await mk('old');
    const recentRevoked = await mk('recent');
    const oldPending = await mk('pending');
    const oldExpired = await mk('expired');
    const oldUsed = await mk('used');
    await db.update(invites).set({ revokedAt: longAgo }).where(eq(invites.id, oldRevoked));
    await db.update(invites).set({ revokedAt: recent }).where(eq(invites.id, recentRevoked));
    await db.update(invites).set({ createdAt: longAgo }).where(eq(invites.id, oldPending));
    await db.update(invites).set({ createdAt: longAgo, expiresAt: longAgo }).where(eq(invites.id, oldExpired));
    await db.update(invites).set({ createdAt: longAgo, acceptedAt: longAgo }).where(eq(invites.id, oldUsed));

    const purged = await invitesService.purgeRevoked();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await row(oldRevoked), 'an old tombstone is gone').toBeUndefined();
    for (const [label, id] of [['recent tombstone', recentRevoked], ['pending', oldPending], ['expired', oldExpired], ['used', oldUsed]] as const) {
      expect(await row(id), `${label} is KEPT`).toBeDefined();
    }
  });

  it('a purged tombstone reads like a link that never existed: the one neutral body', async () => {
    const { owner, ws, inviteId, token } = await inviteSomeone(`${unique('gone')}@test.storyos.dev`);
    await revoke(owner.token, ws.id, inviteId);
    await db.update(invites).set({ revokedAt: new Date(Date.now() - REVOKED_INVITE_RETENTION_MS - DAY_MS) }).where(eq(invites.id, inviteId));
    await invitesService.purgeRevoked();
    expect((await details(token)).json()).toEqual(NOT_FOUND);
  });
});
