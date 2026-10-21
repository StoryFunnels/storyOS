// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { oauthAccessToken } from '../src/db/auth-schema';
import { memberships } from '../src/db/schema';

/**
 * #967 — "does this workspace have an active MCP OAuth connection?" The checklist's `ai_connected` only sees personal access
 * tokens (api_tokens rows). A hosted-MCP OAuth token belongs to a USER and a client and writes no api_tokens row, so someone
 * who connected Claude that way read as "no AI connected". `mcp_oauth_connected` is the OAuth half, from the real tables.
 */
const { db } = connectTestDb();
let app: NestFastifyApplication;
const b64url = (b: Buffer) => b.toString('base64url');

async function registerClient(): Promise<string> {
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/register',
    payload: { redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], client_name: 'onboarding-connector' },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return reg.json().client_id as string;
}

/** The full authorization-code + PKCE flow, as a claude.ai connector runs it. Returns the issued token response. */
async function connectClaude(sessionToken: string): Promise<Record<string, unknown>> {
  const clientId = await registerClient();
  const disc = await app.inject({ method: 'GET', url: '/api/v1/auth/.well-known/oauth-authorization-server' });
  const scope = (disc.json().scopes_supported as string[]).join(' ');
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://example.com/cb', scope, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
  const authRes = await app.inject({ method: 'GET', url: `/api/v1/auth/mcp/authorize?${q}`, headers: { authorization: `Bearer ${sessionToken}` } });
  expect(authRes.statusCode).toBe(302);
  const code = new URL(String(authRes.headers.location)).searchParams.get('code')!;
  const tok = await app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://example.com/cb', client_id: clientId, code_verifier: verifier }).toString(),
  });
  expect(tok.statusCode, tok.body).toBe(200);
  return tok.json();
}

beforeAll(async () => { app = await createTestApp(); }, 120_000);
afterAll(async () => { await app.close(); restoreMcpOAuth(); });

const connected = async (token: string, ws: string) => {
  const res = await call(app, token, 'GET', `/workspaces/${ws}/onboarding`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { mcp_oauth_connected: boolean; ai_connected: boolean };
};

describe('#967 mcp_oauth_connected', () => {
  it('false until someone connects, true once an active member has a live OAuth token — and ai_connected stays false (it is the PAT fact)', async () => {
    const owner = await signUpUser(app, 'Connect Owner');
    const ws = (await call(app, owner.token, 'POST', '/workspaces', { name: 'Connect WS' })).json().id as string;
    expect(await connected(owner.token, ws)).toMatchObject({ mcp_oauth_connected: false, ai_connected: false });
    await connectClaude(owner.token);
    expect(await connected(owner.token, ws)).toMatchObject({ mcp_oauth_connected: true, ai_connected: false });
  });

  it('a workspace nobody connected from stays false, even while another person is connected elsewhere', async () => {
    const a = await signUpUser(app, 'Connect A');
    const b = await signUpUser(app, 'Connect B');
    const wsA = (await call(app, a.token, 'POST', '/workspaces', { name: 'A WS' })).json().id as string;
    const wsB = (await call(app, b.token, 'POST', '/workspaces', { name: 'B WS' })).json().id as string;
    await connectClaude(a.token);
    expect((await connected(a.token, wsA)).mcp_oauth_connected).toBe(true);
    expect((await connected(b.token, wsB)).mcp_oauth_connected, 'B never connected anything').toBe(false);
  });

  it('a teammate connecting counts for the workspace; removing them stops it', async () => {
    const owner = await signUpUser(app, 'Connect Owner 2');
    const ws = (await call(app, owner.token, 'POST', '/workspaces', { name: 'Team WS' })).json().id as string;
    const mate = await joinAs(app, owner.token, ws, 'Connect Mate', 'member');
    await connectClaude(mate.token);
    expect((await connected(owner.token, ws)).mcp_oauth_connected, 'the workspace has a connected AI client, whoever connected it').toBe(true);
    const members = (await call(app, owner.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id?: string; userId?: string }>;
    const mateRow = members.find((m) => (m.user_id ?? m.userId) === mate.id)!;
    expect((await call(app, owner.token, 'DELETE', `/workspaces/${ws}/members/${mateRow.id}`)).statusCode).toBe(200);
    expect((await connected(owner.token, ws)).mcp_oauth_connected, 'a removed member does not count').toBe(false);
  });

  it('a PENDING membership (invited, not yet active) does not count', async () => {
    const owner = await signUpUser(app, 'Connect Owner 4');
    const ws = (await call(app, owner.token, 'POST', '/workspaces', { name: 'Pending WS' })).json().id as string;
    const mate = await joinAs(app, owner.token, ws, 'Connect Pending', 'member');
    await connectClaude(mate.token);
    expect((await connected(owner.token, ws)).mcp_oauth_connected).toBe(true);
    await db.update(memberships).set({ status: 'pending' }).where(eq(memberships.userId, mate.id));
    expect((await connected(owner.token, ws)).mcp_oauth_connected).toBe(false);
  });

  it('revoked (the token row is deleted) and expired (both expiries in the past) read as not connected', async () => {
    const owner = await signUpUser(app, 'Connect Owner 3');
    const me = (await call(app, owner.token, 'GET', '/me')).json();
    const ws = (await call(app, owner.token, 'POST', '/workspaces', { name: 'Revoke WS' })).json().id as string;
    await connectClaude(owner.token);
    expect((await connected(owner.token, ws)).mcp_oauth_connected).toBe(true);

    const past = new Date(Date.now() - 60_000);
    await db.update(oauthAccessToken).set({ accessTokenExpiresAt: past, refreshTokenExpiresAt: past }).where(eq(oauthAccessToken.userId, me.id));
    expect((await connected(owner.token, ws)).mcp_oauth_connected, 'expired').toBe(false);

    await db.update(oauthAccessToken).set({ accessTokenExpiresAt: new Date(Date.now() + 3_600_000), refreshTokenExpiresAt: null }).where(eq(oauthAccessToken.userId, me.id));
    expect((await connected(owner.token, ws)).mcp_oauth_connected, 'live again').toBe(true);

    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, me.id));
    expect((await connected(owner.token, ws)).mcp_oauth_connected, 'revoked').toBe(false);
  });
});
