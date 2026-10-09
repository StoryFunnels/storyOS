// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #858 — an AI connected through the hosted-MCP OAuth connector is `mcp`, exactly as a PAT is.
 *
 * The auth guard used to stamp an OAuth access token `source: 'human'`, though its own comment says
 * every such token is by construction an MCP token. ADR-0010 / #442 and every action gate key on
 * `req.auth.source`, so that one word decided whether an AI could publish a skill workspace-wide
 * and whether a gated delete was held. Every assertion here runs the SAME call as an OAuth token
 * and as a PAT, so "OAuth behaves like the PAT" is measured, not asserted from the guard's code;
 * and a SESSION control proves the people were not caught by the change.
 */
const b64url = (b: Buffer) => b.toString('base64url');

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  restoreMcpOAuth();
});

async function registerClient(): Promise<string> {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mcp/register',
    payload: {
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'test-connector',
    },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return reg.json().client_id as string;
}

/**
 * Drive the full authorization-code + PKCE flow. If `scope` is omitted, the
 * scopes are read from the AS discovery document — i.e. exactly the set a
 * spec-conformant client (claude.ai) would request. That is the scenario #331
 * is about: the token must end up carrying `storyos.mcp`.
 */
async function runOAuthFlow(
  sessionToken: string,
  clientId: string,
  scope?: string,
): Promise<{ authorizeLocation: string; token?: Record<string, unknown> }> {
  let requestedScope = scope;
  if (requestedScope === undefined) {
    const disc = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/.well-known/oauth-authorization-server',
    });
    requestedScope = (disc.json().scopes_supported as string[]).join(' ');
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const redirectUri = 'https://example.com/cb';

  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: requestedScope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
  });
  const authRes = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/mcp/authorize?${q.toString()}`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  expect(authRes.statusCode).toBe(302);
  const location = String(authRes.headers.location);
  const code = new URL(location).searchParams.get('code');
  if (!code) return { authorizeLocation: location };

  const tokRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mcp/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  expect(tokRes.statusCode, tokRes.body).toBe(200);
  return { authorizeLocation: location, token: tokRes.json() };
}



let sessionTok: string;
let wsId: string;
let oauth: string;
let pat: string;
const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: 'd', when_to_use: 'w', instructions: 'i', ...extra,
});

beforeAll(async () => {
  sessionTok = (await signUpUser(app, 'OAuth Source Admin')).token;
  wsId = (await as(sessionTok, 'POST', '/workspaces', { name: '858 WS' })).json().id as string;
  const clientId = await registerClient();
  const { token } = await runOAuthFlow(sessionTok, clientId);
  oauth = String(token!.access_token);
  pat = (await as(sessionTok, 'POST', '/me/tokens', { name: 'ctl-pat', workspace_id: wsId })).json().token as string;
});

describe('#858 — an OAuth-connected AI is classified like a PAT, never like a person', () => {
  it('it really is the OAuth path being exercised (not a PAT in disguise)', async () => {
    expect((await as(oauth, 'GET', '/me')).json().auth.via).toBe('oauth');
    expect((await as(pat, 'GET', '/me')).json().auth.via).toBe('token');
  });

  for (const [label, tok] of [['OAUTH', () => oauth], ['PAT', () => pat]] as const) {
    it(`${label}: omitted visibility -> personal, source mcp (response AND stored row); shared and public -> 403`, async () => {
      const t = tok();
      const dflt = await as(t, 'POST', `/workspaces/${wsId}/skills`, skill(`${label} default`));
      expect(dflt.statusCode, dflt.body).toBe(201);
      expect(dflt.json().visibility).toBe('personal');
      expect(dflt.json().source).toBe('mcp');
      const stored = await as(sessionTok, 'GET', `/workspaces/${wsId}/skills/${dflt.json().id}`);
      // The owner reads their own personal skill; the stored row says mcp too.
      expect(stored.json().source).toBe('mcp');
      expect(stored.json().visibility).toBe('personal');
      for (const visibility of ['shared', 'public', 'members']) {
        const res = await as(t, 'POST', `/workspaces/${wsId}/skills`, skill(`${label} ${visibility}`, { visibility }));
        expect(res.statusCode, `${visibility}: ${res.body}`).toBe(403);
      }
    });
  }

  it('CONTROL: a person (session) still gets a shared skill by default and may publish', async () => {
    const dflt = await as(sessionTok, 'POST', `/workspaces/${wsId}/skills`, skill('person default'));
    expect(dflt.statusCode, dflt.body).toBe(201);
    expect(dflt.json().visibility).toBe('shared');
    expect(dflt.json().source).toBe('human');
    const pub = await as(sessionTok, 'POST', `/workspaces/${wsId}/skills`, skill('person public', { visibility: 'public' }));
    expect(pub.statusCode, pub.body).toBe(201);
  });

  it('action gates: a delete the workspace gated is HELD for an OAuth AI exactly as for a PAT, and still allowed for a person', async () => {
    const spaceId = (await as(sessionTok, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as(sessionTok, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Gated' })).json().id as string;
    const me = (await as(sessionTok, 'GET', '/me')).json();
    const policy = await as(sessionTok, 'POST', `/workspaces/${wsId}/action-gates`, {
      action_class: 'delete_records', approver_id: me.user?.id ?? me.id,
    });
    expect(policy.statusCode, policy.body).toBeLessThan(300);
    const mk = async (name: string) =>
      (await as(sessionTok, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name } })).json().id as string;
    try {
      for (const [label, tok] of [['OAUTH', oauth], ['PAT', pat]] as const) {
        const rec = await mk(`${label} gated`);
        const res = await as(tok, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec}`);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().pending_approval, `${label} held`).toBe(true);
        const still = await as(sessionTok, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec}`);
        expect(still.statusCode, `${label}: record NOT deleted`).toBe(200);
      }
      const mine = await mk('person deletes');
      const res = await as(sessionTok, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${mine}`);
      expect(res.json()).toEqual({ deleted: true });
    } finally {
      await as(sessionTok, 'DELETE', `/workspaces/${wsId}/action-gates/${policy.json().id}`);
    }
  });
});
