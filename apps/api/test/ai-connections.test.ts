// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { connectMcpClient } from './helpers/mcp-oauth-flow';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user } from '../src/db/schema';
import { oauthAccessToken, oauthConsent } from '../src/db/auth-schema';
import { ActivationService } from '../src/workspaces/activation.service';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * ticket #1008 — "Connect your AI" needs WHAT is connected, not only THAT something is: the AI clients the caller has connected as one
 * list (name, OAuth or token, since when), and a disconnect. The list reads the same row conditions as the activation flag
 * (`ai-connection-predicates.ts`), so the two cannot disagree about what counts.
 */
let app: NestFastifyApplication;
let db: Db;
let activation: ActivationService;
let tokens: TokensService;
const as = (t: string, method: string, url: string, payload?: unknown) => call(app, t, method, url, payload);
const list = async (t: string, ws: string) => (await as(t, 'GET', `/me/ai-connections?workspace_id=${ws}`)).json().data as Array<{ id: string; kind: string; client_name: string; connected_at: string | null; last_used_at: string | null; reaches: string }>;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  activation = app.get(ActivationService);
  tokens = app.get(TokensService);
}, 120_000);
afterAll(async () => { await app.close(); restoreMcpOAuth(); });

async function person(label: string) {
  const u = await signUpUser(app, label);
  const userId = (await db.query.user.findFirst({ where: eq(user.email, u.email) }))!.id;
  const ws = (await as(u.token, 'POST', '/workspaces', { name: label })).json().id as string;
  return { token: u.token, userId, ws };
}
const mintPat = async (p: { token: string; ws: string }, name = 'my-cli') => (await as(p.token, 'POST', '/me/tokens', { name, workspace_id: p.ws, scope: 'admin' })).json() as { id: string; token: string };

describe('#1008 the list of connected AI clients', () => {
  it('neither: an empty list, and the activation flag agrees', async () => {
    const p = await person('AIC Neither');
    expect(await list(p.token, p.ws)).toEqual([]);
    expect(await activation.aiConnected(p.ws)).toBe(false);
  });

  it('a personal access token: kind token, the name the person gave, since when, this workspace only', async () => {
    const p = await person('AIC Token');
    const pat = await mintPat(p, 'my-laptop-cli');
    const rows = await list(p.token, p.ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `token:${pat.id}`, kind: 'token', client_name: 'my-laptop-cli', reaches: 'this_workspace', last_used_at: null });
    expect(Date.parse(rows[0]!.connected_at!)).not.toBeNaN();
    expect(await activation.aiConnected(p.ws)).toBe(true);
    await as(pat.token, 'GET', '/me');
    expect((await list(p.token, p.ws))[0]!.last_used_at, 'using the token is recorded').not.toBeNull();
  });

  it('an OAuth connection: kind oauth, the client\'s registered name, reaches ONLY the workspace the person approved (#1030)', async () => {
    const p = await person('AIC OAuth');
    await connectMcpClient(app, p.token);
    const rows = await list(p.token, p.ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'oauth', client_name: 'test-connector', reaches: 'one_workspace', last_used_at: null, approved: { workspace_name: expect.any(String), access: 'write' } });
    expect(rows[0]!.id).toMatch(/^oauth:/);
    expect(Date.parse(rows[0]!.connected_at!)).not.toBeNaN();
    expect(await activation.aiConnected(p.ws)).toBe(true);
    // the same connection shows from the person's OTHER workspace
    const ws2 = (await as(p.token, 'POST', '/workspaces', { name: 'AIC OAuth 2' })).json().id as string;
    expect((await list(p.token, ws2)).map((r) => r.kind)).toEqual(['oauth']);
  });

  it('#1030: a connection with NO approval (made before consent existed) is listed as needing a reconnect, reaching nothing', async () => {
    const p = await person('AIC No Grant');
    await connectMcpClient(app, p.token);
    await db.delete(oauthConsent);
    const rows = await list(p.token, p.ws);
    expect(rows[0]).toMatchObject({ kind: 'oauth', reaches: 'needs_reconnect', approved: null });
  });

  it('both, and two clients: one row per client however many tokens it has cycled through, oldest first', async () => {
    const p = await person('AIC Both');
    await connectMcpClient(app, p.token);
    await connectMcpClient(app, p.token);
    const pat = await mintPat(p);
    const [first] = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, p.userId));
    // a refresh cycled a second token for the same client: still ONE connection
    await db.insert(oauthAccessToken).values({ ...first!, id: randomUUID(), accessToken: randomUUID(), refreshToken: randomUUID() });
    const rows = await list(p.token, p.ws);
    expect(rows.map((r) => r.kind).sort()).toEqual(['oauth', 'oauth', 'token']);
    expect(rows.filter((r) => r.kind === 'oauth')).toHaveLength(2);
    expect(rows.map((r) => r.connected_at!)).toEqual([...rows.map((r) => r.connected_at!)].sort());
    expect(rows.some((r) => r.id === `token:${pat.id}`)).toBe(true);
  });

  it('an expired OAuth connection (access AND refresh token past their expiry) and a revoked token are not listed', async () => {
    const p = await person('AIC Expired');
    await connectMcpClient(app, p.token);
    const past = new Date(Date.now() - 86_400_000);
    await db.update(oauthAccessToken).set({ accessTokenExpiresAt: past, refreshTokenExpiresAt: past }).where(eq(oauthAccessToken.userId, p.userId));
    expect(await list(p.token, p.ws)).toEqual([]);
    expect(await activation.aiConnected(p.ws), 'the flag agrees').toBe(false);
    const pat = await mintPat(p);
    await as(p.token, 'DELETE', `/me/tokens/${pat.id}`);
    expect(await list(p.token, p.ws)).toEqual([]);
  });

  it('Tyron\'s per-turn token is not "a client the person connected"; a token minted for a configured agent is', async () => {
    const p = await person('AIC Agent');
    await tokens.create(p.userId, p.ws, 'tyron-turn', 'admin', true, 'agent');
    expect(await list(p.token, p.ws)).toEqual([]);
    expect(await activation.aiConnected(p.ws)).toBe(false);
    await as(p.token, 'POST', `/workspaces/${p.ws}/agents/ensure`);
    const dbs = (await as(p.token, 'GET', `/workspaces/${p.ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const agentsDb = dbs.find((d) => d.name === 'Agents')!.id;
    const agent = (await as(p.token, 'POST', `/workspaces/${p.ws}/databases/${agentsDb}/records`, { values: { name: 'Triage' } })).json().id as string;
    await tokens.create(p.userId, p.ws, 'triage-agent', 'admin', true, 'agent', agent);
    expect((await list(p.token, p.ws)).map((r) => r.client_name)).toEqual(['triage-agent']);
    expect(await activation.aiConnected(p.ws)).toBe(true);
  });

  it('only MY connections: a teammate\'s never appear, and a non-member of the workspace gets 404', async () => {
    const a = await person('AIC Mine');
    await mintPat(a, 'a-token');
    await connectMcpClient(app, a.token);
    const mate = await joinAs(app, a.token, a.ws, 'AIC Mate', 'member');
    expect(await list(mate.token, a.ws), 'the workspace is connected, but not by the teammate').toEqual([]);
    expect(await activation.aiConnected(a.ws)).toBe(true);
    const outsider = await signUpUser(app, 'AIC Outsider');
    expect((await as(outsider.token, 'GET', `/me/ai-connections?workspace_id=${a.ws}`)).statusCode).toBe(404);
    expect([400, 422]).toContain((await as(a.token, 'GET', '/me/ai-connections?workspace_id=nope')).statusCode);
    expect([400, 422]).toContain((await as(a.token, 'GET', '/me/ai-connections')).statusCode);
  });
});

describe('#1008 disconnect', () => {
  it('a token: revoked at once, gone from the list, and the token stops working', async () => {
    const p = await person('AIC Del Token');
    const pat = await mintPat(p);
    expect((await as(pat.token, 'GET', '/me')).statusCode).toBe(200);
    expect((await as(p.token, 'DELETE', `/me/ai-connections/token:${pat.id}`)).json()).toEqual({ disconnected: true });
    expect(await list(p.token, p.ws)).toEqual([]);
    expect((await as(pat.token, 'GET', '/me')).statusCode).toBe(401);
    expect((await as(p.token, 'DELETE', `/me/ai-connections/token:${pat.id}`)).statusCode, 'again: not found').toBe(404);
  });

  it('an OAuth client: every token and the consent are removed, and its next call is 401', async () => {
    const p = await person('AIC Del OAuth');
    const tok = await connectMcpClient(app, p.token);
    const access = tok.access_token as string;
    expect((await as(access, 'GET', '/me')).statusCode).toBe(200);
    const [conn] = await list(p.token, p.ws);
    expect((await as(p.token, 'DELETE', `/me/ai-connections/${encodeURIComponent(conn!.id)}`)).json()).toEqual({ disconnected: true });
    expect(await list(p.token, p.ws)).toEqual([]);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, p.userId))).toHaveLength(0);
    expect(await db.select().from(oauthConsent).where(eq(oauthConsent.userId, p.userId))).toHaveLength(0);
    expect((await as(access, 'GET', '/me')).statusCode, 'the disconnected client is locked out').toBe(401);
    expect(await activation.aiConnected(p.ws)).toBe(false);
    expect((await as(p.token, 'DELETE', `/me/ai-connections/${encodeURIComponent(conn!.id)}`)).statusCode).toBe(404);
  });

  it('disconnecting one client leaves the others', async () => {
    const p = await person('AIC Del One');
    await connectMcpClient(app, p.token);
    await connectMcpClient(app, p.token);
    const pat = await mintPat(p);
    const rows = await list(p.token, p.ws);
    const firstOauth = rows.find((r) => r.kind === 'oauth')!;
    await as(p.token, 'DELETE', `/me/ai-connections/${encodeURIComponent(firstOauth.id)}`);
    const after = await list(p.token, p.ws);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.id)).not.toContain(firstOauth.id);
    expect(after.some((r) => r.id === `token:${pat.id}`)).toBe(true);
  });

  it('only the caller\'s own: someone else\'s connection is "not found" and stays connected', async () => {
    const a = await person('AIC Own A');
    const b = await person('AIC Own B');
    const pat = await mintPat(a);
    await connectMcpClient(app, a.token);
    const [oauth] = (await list(a.token, a.ws)).filter((r) => r.kind === 'oauth');
    expect((await as(b.token, 'DELETE', `/me/ai-connections/token:${pat.id}`)).statusCode).toBe(404);
    expect((await as(b.token, 'DELETE', `/me/ai-connections/${encodeURIComponent(oauth!.id)}`)).statusCode).toBe(404);
    for (const bad of ['token:not-a-uuid', 'oauth:', 'nonsense', 'token:']) expect((await as(b.token, 'DELETE', `/me/ai-connections/${encodeURIComponent(bad)}`)).statusCode, bad).toBe(404);
    expect(await list(a.token, a.ws)).toHaveLength(2);
  });

  it('only a signed-in person can disconnect: an API token and an OAuth client are refused (403) and nothing is removed', async () => {
    const p = await person('AIC Human Only');
    const pat = await mintPat(p);
    const tok = await connectMcpClient(app, p.token);
    const rows = await list(p.token, p.ws);
    expect(rows).toHaveLength(2);
    for (const bearer of [pat.token, tok.access_token as string]) {
      for (const r of rows) expect((await as(bearer, 'DELETE', `/me/ai-connections/${encodeURIComponent(r.id)}`)).statusCode).toBe(403);
    }
    expect(await list(p.token, p.ws), 'an agent can LIST but never cut off the person\'s clients').toHaveLength(2);
    expect((await as(pat.token, 'GET', `/me/ai-connections?workspace_id=${p.ws}`)).statusCode).toBe(200);
  });
});
