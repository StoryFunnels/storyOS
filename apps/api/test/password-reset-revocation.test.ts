// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectMcpClient } from './helpers/mcp-oauth-flow';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user } from '../src/db/schema';
import { oauthAccessToken } from '../src/db/auth-schema';
import { EmailService } from '../src/mail/email.service';

/**
 * #1077 — resetting a password is what a person does after a compromise, so afterwards nothing the attacker may hold still works:
 * not a session, and not a connected-AI OAuth access/refresh token. The person can sign in with the new password. A PAT is a
 * deliberately long-lived API key and is NOT revoked by a reset (pinned here so a change to that is a decision, not an accident).
 */
let app: NestFastifyApplication;
let db: Db;
let send: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  send = vi.spyOn(app.get(EmailService), 'send').mockResolvedValue(undefined as never);
}, 120_000);
afterAll(async () => { await app.close(); restoreMcpOAuth(); });

const me = (bearer: string) => app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(bearer) });

/** Request a reset the way the "forgot password" page does, and pull the token out of the emailed link. */
async function resetPassword(email: string, newPassword: string) {
  send.mockClear();
  const req = await app.inject({ method: 'POST', url: '/api/v1/auth/request-password-reset', payload: { email, redirectTo: 'http://localhost:3000/reset-password' } });
  expect(req.statusCode, req.body).toBe(200);
  const mail = send.mock.calls.map((c) => c[0] as { kind: string; url: string }).find((m) => m.kind === 'reset-password');
  expect(mail, 'a reset email was sent').toBeDefined();
  const token = new URL(mail!.url).pathname.split('/').pop()!;
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, newPassword } });
  expect(res.statusCode, res.body).toBe(200);
}

describe('#1077 a password reset revokes sessions and connected-AI tokens', () => {
  it('the old session and OAuth access token get 401, the refresh token is gone, the new password signs in, a PAT survives', async () => {
    const { token: session, email } = await signUpUser(app, 'Reset Victim');
    const userId = (await db.query.user.findFirst({ where: eq(user.email, email) }))!.id;
    const oauth = await connectMcpClient(app, session);
    const ws = ((await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: authed(session) })).json() as Array<{ id: string }>)[0]!.id;
    const pat = (await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: authed(session), payload: { name: 'cli', workspace_id: ws, scope: 'admin' } })).json().token as string;

    // Everything works before the reset — otherwise the 401s below would prove nothing.
    expect((await me(session)).statusCode).toBe(200);
    expect((await me(String(oauth.access_token))).statusCode).toBe(200);
    expect((await me(pat)).statusCode).toBe(200);
    expect(oauth.refresh_token, 'the connector holds a refresh token').toBeTruthy();

    await resetPassword(email, 'brand-new-password-456');

    expect((await me(session)).statusCode, 'the old session is revoked').toBe(401);
    expect((await me(String(oauth.access_token))).statusCode, 'the OAuth access token is revoked').toBe(401);
    // The refresh token lives on the same row as the access token, so no row means neither can be used again.
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId))).toEqual([]);
    expect((await me(pat)).statusCode, 'a PAT is a long-lived API key, not a session').toBe(200);

    const oldPw = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', payload: { email, password: 'test-password-123' } });
    expect(oldPw.statusCode).toBe(401);
    const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', payload: { email, password: 'brand-new-password-456' } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    expect((await me(String(signIn.headers['set-auth-token']))).statusCode).toBe(200);
  });

  it("another person's sessions and OAuth tokens are untouched", async () => {
    const victim = await signUpUser(app, 'Reset Self');
    const other = await signUpUser(app, 'Reset Bystander');
    const otherOauth = await connectMcpClient(app, other.token);

    await resetPassword(victim.email, 'another-new-password-789');

    expect((await me(other.token)).statusCode).toBe(200);
    expect((await me(String(otherOauth.access_token))).statusCode).toBe(200);
  });
});
