import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { invites } from '../src/db/schema';
import { EmailService } from '../src/mail/email.service';

/**
 * Ticket #1302 — an invited person joins the workspace they were invited to; they are never pushed into creating a new one, and
 * an unauthenticated visitor can read who invited them (and nothing else).
 *
 * Every refusal below asserts BOTH the status and that nothing was created: a person's own memberships are the witness (creating a
 * workspace always makes its creator an admin member, so "no membership" is "no workspace created for them"). Counting rows in the
 * workspaces table would be a lie in a suite where other files write to the same database.
 */
let app: NestFastifyApplication;
let db: Db;
let send: ReturnType<typeof vi.spyOn>;

const PASSWORD = 'test-password-123';
let seq = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  send = vi.spyOn(app.get(EmailService), 'send').mockResolvedValue(undefined as never);
}, 120_000);
afterAll(async () => {
  await app.close();
});

const call = (token: string | null, method: string, url: string, payload?: unknown, remoteAddress?: string) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never, remoteAddress });

/** Sign up with a CHOSEN address (the invitee exists as an address before they exist as an account). */
async function signUpAs(email: string, name = 'Invited Person') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-up/email', payload: { email, password: PASSWORD, name } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-auth-token']);
}

/** An admin with a workspace, and an invite (member) for `email`. Returns the plaintext token, which only ever exists in accept_url. */
async function inviteSomeone(email: string, opts: { inviterName?: string; logo?: string } = {}) {
  const owner = await signUpUser(app, opts.inviterName ?? 'Inviter Iris');
  const ws = (await call(owner.token, 'POST', '/workspaces', { name: `Pinewood ${unique('ws')}` })).json() as { id: string; name: string };
  if (opts.logo) expect((await call(owner.token, 'PATCH', `/workspaces/${ws.id}`, { branding: { logo_url: opts.logo } })).statusCode).toBe(200);
  const inv = await call(owner.token, 'POST', `/workspaces/${ws.id}/invites`, { email, role: 'member' });
  expect(inv.statusCode, inv.body).toBe(201);
  const body = inv.json() as { id: string; accept_url: string };
  return { owner, ws, inviteId: body.id, token: new URL(body.accept_url).searchParams.get('token')! };
}

const myWorkspaces = async (token: string) => (await call(token, 'GET', '/workspaces')).json() as Array<{ id: string; role: string }>;
const details = (token: string | undefined, remoteAddress?: string) =>
  call(null, 'GET', `/public/invites/details${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`, undefined, remoteAddress);

/** The single neutral body every unusable token must return. */
const NOT_FOUND = { status: 'not_found', inviter_name: null, workspace_name: null, workspace_logo_url: null, invited_email: null };

describe('GET /public/invites/details (no sign-in)', () => {
  it('says who invited the visitor, to what, for which address, and nothing else', async () => {
    const email = `${unique('invitee')}@test.storyos.dev`;
    const { token, ws, inviteId, owner } = await inviteSomeone(email, { inviterName: 'Ingrid Inviter', logo: 'https://example.test/pinewood.png' });

    const res = await details(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // An EXACT key list: a new field is a decision about what a stranger may learn, not an accident.
    expect(Object.keys(res.json()).sort()).toEqual(['invited_email', 'inviter_name', 'status', 'workspace_logo_url', 'workspace_name']);
    expect(res.json()).toEqual({
      status: 'valid',
      inviter_name: 'Ingrid Inviter',
      workspace_name: ws.name,
      workspace_logo_url: 'https://example.test/pinewood.png',
      invited_email: email,
    });
    // Nothing that names a person, a row or the credential leaves: not the token, its hash, any id, the role, the inviter's email.
    const wire = res.body;
    for (const secret of [token, inviteId, ws.id, owner.email]) expect(wire).not.toContain(secret);
    expect(wire).not.toMatch(/member|guest|admin/);
    expect(wire).not.toMatch(/[0-9a-f]{64}/);
  });

  it('a workspace with no logo reads null, not a missing field', async () => {
    const { token } = await inviteSomeone(`${unique('nologo')}@test.storyos.dev`);
    expect((await details(token)).json().workspace_logo_url).toBeNull();
  });

  it('reads used once accepted and expired once past its date, still naming the workspace and inviter so the screen can say who to ask', async () => {
    const email = `${unique('life')}@test.storyos.dev`;
    const { token, ws } = await inviteSomeone(email, { inviterName: 'Ingrid Inviter' });
    const person = await signUpAs(email);
    expect((await call(person, 'POST', '/invites/accept', { token })).statusCode).toBe(201);
    const used = (await details(token)).json();
    expect(used).toMatchObject({ status: 'used', workspace_name: ws.name, inviter_name: 'Ingrid Inviter', invited_email: email });

    const stale = await inviteSomeone(`${unique('stale')}@test.storyos.dev`, { inviterName: 'Ingrid Inviter' });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, stale.inviteId));
    expect((await details(stale.token)).json()).toMatchObject({ status: 'expired', workspace_name: stale.ws.name, inviter_name: 'Ingrid Inviter' });
  });

  it('unknown, malformed, revoked and replaced tokens all get the same status and the same body (a token cannot be probed)', async () => {
    const revoked = await inviteSomeone(`${unique('rev')}@test.storyos.dev`);
    expect((await call(revoked.owner.token, 'DELETE', `/workspaces/${revoked.ws.id}/invites/${revoked.inviteId}`)).statusCode).toBe(200);

    // A resend mints a fresh token and overwrites the hash: the first link no longer names anything.
    const replaced = await inviteSomeone(`${unique('rep')}@test.storyos.dev`);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 120_000) }).where(eq(invites.id, replaced.inviteId));
    expect((await call(replaced.owner.token, 'POST', `/workspaces/${replaced.ws.id}/invites/${replaced.inviteId}/resend`)).statusCode).toBe(201);

    const probes: Array<[string, string | undefined]> = [
      ['never issued, right shape', 'A'.repeat(32)],
      ['revoked', revoked.token],
      ['replaced by a resend', replaced.token],
      ['missing', undefined],
      ['empty', ''],
      ['one character', 'x'],
      ['a 10 KB string', 'z'.repeat(10_000)],
      ['not base64url', '../../etc/passwd%00<script>'],
    ];
    for (const [label, tok] of probes) {
      const res = await details(tok);
      expect(res.statusCode, label).toBe(200);
      expect(res.json(), label).toEqual(NOT_FOUND);
    }
    // token[]=a&token[]=b arrives as an array, not a string.
    const arr = await call(null, 'GET', '/public/invites/details?token=aaaaaaaaaaaaaaaaaaaaaaaaa&token=bbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(arr.statusCode).toBe(200);
    expect(arr.json()).toEqual(NOT_FOUND);
  });

  it('never accepts: a GET with a valid token leaves the invite unused and the visitor a non-member', async () => {
    const email = `${unique('readonly')}@test.storyos.dev`;
    const { token, inviteId } = await inviteSomeone(email);
    await details(token);
    expect((await db.query.invites.findFirst({ where: eq(invites.id, inviteId) }))!.acceptedAt).toBeNull();
  });

  it('is rate limited per client address: the 21st read in a minute is a 429, and another address is unaffected', async () => {
    const { token } = await inviteSomeone(`${unique('rl')}@test.storyos.dev`);
    const ip = '203.0.113.50';
    for (let i = 0; i < 20; i++) expect((await details(token, ip)).statusCode, `read ${i + 1}`).toBe(200);
    const blocked = await details(token, ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.body).not.toContain(token);
    expect((await details(token, '203.0.113.51')).statusCode).toBe(200);
  });
});

describe('an invite token on POST /workspaces joins the workspace and creates none', () => {
  it('sign-up with the invited address, then the token: joined as the invited role, no workspace of their own, invite used', async () => {
    const email = `${unique('signup')}@test.storyos.dev`;
    const { token, ws, inviteId } = await inviteSomeone(email);
    const person = await signUpAs(email);
    expect(await myWorkspaces(person), 'a fresh account owns nothing').toEqual([]);

    const res = await call(person, 'POST', '/workspaces', { invite_token: token });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ id: ws.id, name: ws.name, role: 'member', joined_via_invite: true });

    const mine = await myWorkspaces(person);
    expect(mine.map((w) => w.id), 'the ONLY workspace is the one they were invited to').toEqual([ws.id]);
    expect(mine[0]!.role, 'a member, not the admin of a new workspace').toBe('member');
    expect((await db.query.invites.findFirst({ where: eq(invites.id, inviteId) }))!.acceptedAt).not.toBeNull();
  });

  it('survives email verification: verify the address from the emailed link, then the token still joins and creates nothing', async () => {
    const email = `${unique('verify')}@test.storyos.dev`;
    const { token, ws } = await inviteSomeone(email);
    send.mockClear();
    const person = await signUpAs(email);
    const mail = send.mock.calls.map((c) => c[0] as { kind: string; url: string }).find((m) => m.kind === 'verify-email');
    expect(mail, 'sign-up sent a verification email').toBeDefined();
    const link = new URL(mail!.url);
    const verified = await app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect([200, 302], verified.body).toContain(verified.statusCode);
    expect((await call(person, 'GET', '/me')).json().email_verified, 'the address really is verified now').toBe(true);

    const res = await call(person, 'POST', '/workspaces', { invite_token: token });
    expect(res.statusCode, res.body).toBe(201);
    expect((await myWorkspaces(person)).map((w) => w.id)).toEqual([ws.id]);
  });

  it('survives a password reset: reset from the emailed link, sign in with the new password, and the token still joins and creates nothing', async () => {
    const email = `${unique('reset')}@test.storyos.dev`;
    const { token, ws } = await inviteSomeone(email);
    await signUpAs(email);
    send.mockClear();
    const req = await app.inject({ method: 'POST', url: '/api/v1/auth/request-password-reset', payload: { email, redirectTo: 'http://localhost:3000/reset-password' } });
    expect(req.statusCode, req.body).toBe(200);
    const mail = send.mock.calls.map((c) => c[0] as { kind: string; url: string }).find((m) => m.kind === 'reset-password');
    expect(mail, 'a reset email was sent').toBeDefined();
    const resetToken = new URL(mail!.url).pathname.split('/').pop()!;
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: resetToken, newPassword: 'brand-new-password-456' } })).statusCode).toBe(200);
    const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', payload: { email, password: 'brand-new-password-456' } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const person = String(signIn.headers['set-auth-token']);

    const res = await call(person, 'POST', '/workspaces', { invite_token: token });
    expect(res.statusCode, res.body).toBe(201);
    expect((await myWorkspaces(person)).map((w) => w.id)).toEqual([ws.id]);
  });

  it('a token the person cannot use refuses and creates nothing, on this route AND on POST /invites/accept', async () => {
    const email = `${unique('refuse')}@test.storyos.dev`;
    const person = await signUpAs(email);

    // unknown
    const unknown = 'N'.repeat(32);
    // expired
    const expired = await inviteSomeone(email);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.inviteId));
    // revoked
    const revoked = await inviteSomeone(email);
    await call(revoked.owner.token, 'DELETE', `/workspaces/${revoked.ws.id}/invites/${revoked.inviteId}`);
    // issued to someone else
    const other = await inviteSomeone(`${unique('someone-else')}@test.storyos.dev`);

    const cases: Array<[string, string, number, string]> = [
      ['unknown', unknown, 404, 'invite_not_found'],
      ['expired', expired.token, 404, 'invite_expired'],
      ['revoked', revoked.token, 404, 'invite_not_found'],
      ['issued to a different address', other.token, 403, 'invite_email_mismatch'],
    ];
    for (const [label, tok, status, code] of cases) {
      const viaCreate = await call(person, 'POST', '/workspaces', { name: 'Should Not Exist', invite_token: tok });
      expect(viaCreate.statusCode, `${label}: POST /workspaces`).toBe(status);
      expect(viaCreate.json().error?.code ?? viaCreate.json().code, `${label}: POST /workspaces code`).toBe(code);
      expect(viaCreate.body, `${label}: the token is never echoed`).not.toContain(tok);
      const viaAccept = await call(person, 'POST', '/invites/accept', { token: tok });
      expect(viaAccept.statusCode, `${label}: POST /invites/accept`).toBe(status);
      expect(await myWorkspaces(person), `${label}: nothing was created and nothing joined`).toEqual([]);
    }
    // A refused mismatch burns nothing: the person it was issued to can still use it.
    const rightPerson = await signUpAs(`${(await db.query.invites.findFirst({ where: eq(invites.id, other.inviteId) }))!.email}`);
    expect((await call(rightPerson, 'POST', '/workspaces', { invite_token: other.token })).statusCode).toBe(201);
  });

  it('a used token cannot be used again, and a person already in the workspace is told so, not given a second one', async () => {
    const email = `${unique('again')}@test.storyos.dev`;
    const { token, ws, owner } = await inviteSomeone(email);
    const person = await signUpAs(email);
    expect((await call(person, 'POST', '/workspaces', { invite_token: token })).statusCode).toBe(201);

    const again = await call(person, 'POST', '/workspaces', { invite_token: token });
    expect(again.statusCode).toBe(404); // used reads as not found, like a revoked one
    expect((await call(person, 'POST', '/invites/accept', { token })).statusCode).toBe(404);
    expect((await myWorkspaces(person)).map((w) => w.id), 'still only the invited workspace').toEqual([ws.id]);

    // Invited AGAIN while already inside: a fresh, valid token. 409 and nothing created or duplicated.
    const reinvite = await call(owner.token, 'POST', `/workspaces/${ws.id}/invites`, { email, role: 'member' });
    expect(reinvite.statusCode, reinvite.body).toBe(201);
    const second = new URL(reinvite.json().accept_url).searchParams.get('token')!;
    const dup = await call(person, 'POST', '/workspaces', { invite_token: second });
    expect(dup.statusCode).toBe(409);
    expect((await myWorkspaces(person)).map((w) => w.id)).toEqual([ws.id]);
  });

  it('signing up with ANOTHER email and a valid token does not join, creates nothing, and leaves the invite usable by its owner', async () => {
    const invitedEmail = `${unique('invited')}@test.storyos.dev`;
    const { token, inviteId } = await inviteSomeone(invitedEmail);
    const stranger = await signUpAs(`${unique('stranger')}@test.storyos.dev`);

    const res = await call(stranger, 'POST', '/workspaces', { invite_token: token });
    expect(res.statusCode).toBe(403);
    expect(await myWorkspaces(stranger)).toEqual([]);
    expect((await db.query.invites.findFirst({ where: eq(invites.id, inviteId) }))!.acceptedAt, 'the invite is untouched').toBeNull();
    expect((await call(stranger, 'POST', '/invites/accept', { token })).statusCode).toBe(403);
  });

  it('KEPT: a sign-up with no token still creates its own workspace, exactly as before', async () => {
    const person = await signUpUser(app, 'Plain Signup');
    const res = await call(person.token, 'POST', '/workspaces', { name: 'My Own Place' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ name: 'My Own Place', slug: expect.any(String) });
    expect(res.json()).not.toHaveProperty('joined_via_invite');
    const mine = await myWorkspaces(person.token);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: res.json().id, role: 'admin' });
    const spaces = (await call(person.token, 'GET', `/workspaces/${res.json().id}/spaces`)).json() as Array<{ name: string }>;
    expect(spaces.map((s) => s.name)).toEqual(['General']);
  });

  it('KEPT: creating a workspace still needs a name, and an unusable token is not a way around that', async () => {
    const person = await signUpUser(app, 'Nameless');
    const none = await call(person.token, 'POST', '/workspaces', {});
    expect([400, 422]).toContain(none.statusCode);
    expect(await myWorkspaces(person.token)).toEqual([]);
    const tooShort = await call(person.token, 'POST', '/workspaces', { name: 'X', invite_token: 'short' });
    expect([400, 422]).toContain(tooShort.statusCode);
    expect(await myWorkspaces(person.token)).toEqual([]);
  });
});
