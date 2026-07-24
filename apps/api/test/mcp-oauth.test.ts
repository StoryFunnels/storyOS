// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #331 — hosted-MCP OAuth (MN-154). Exercises the real, wired-up authorization
 * server (via app.inject → the full Fastify dispatch that mounts better-auth)
 * end to end, because that is exactly what a claude.ai connector talks to.
 *
 * The bug: the API guard REQUIRES the `storyos.mcp` scope on an OAuth access
 * token (auth.guard.ts → hasStoryOsMcpScope), a token carries `storyos.mcp` only
 * if the client requests it, and a client only requests scopes the AS discovery
 * document advertises. better-auth 1.6.23's mcp plugin HARDCODES that document's
 * `scopes_supported` and ignores `oidcConfig.metadata.scopes_supported`, so
 * `storyos.mcp` was never advertised → never requested → never granted → every
 * tool call 401'd with "Authentication required". These pin the fix: the AS
 * document advertises `storyos.mcp`, so a client that mirrors it gets a token
 * the guard accepts. PAT auth must keep working with MCP_OAUTH on.
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

describe('#331 hosted-MCP OAuth scope discovery', () => {
  it('advertises storyos.mcp in the authorization-server discovery document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/.well-known/oauth-authorization-server',
    });
    expect(res.statusCode).toBe(200);
    const scopes = res.json().scopes_supported as string[];
    expect(scopes).toContain('storyos.mcp');
    // The plugin's baseline scopes must survive the augmentation.
    expect(scopes).toEqual(expect.arrayContaining(['openid', 'profile', 'email', 'offline_access']));
  });

  it('a client that mirrors the discovery document gets a token the API accepts', async () => {
    const { token: session } = await signUpUser(app, 'MCP OAuth User');
    const clientId = await registerClient();

    // No explicit scope → uses whatever the discovery document advertises.
    const { token } = await runOAuthFlow(session, clientId);
    expect(token, 'authorize must not reject the advertised scopes').toBeDefined();
    expect(String(token!.scope)).toContain('storyos.mcp');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token!.access_token}` },
    });
    expect(me.statusCode, 'the guard requires storyos.mcp; the token must carry it').toBe(200);
    expect(me.json().auth.via).toBe('oauth');
  });

  it('an OAuth token WITHOUT storyos.mcp is refused (the guard boundary holds)', async () => {
    const { token: session } = await signUpUser(app, 'MCP Plain User');
    const clientId = await registerClient();

    const { token } = await runOAuthFlow(session, clientId, 'openid profile email');
    expect(token).toBeDefined();
    expect(String(token!.scope)).not.toContain('storyos.mcp');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token!.access_token}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('#331 PAT coexistence with MCP_OAUTH on', () => {
  it('a valid PAT still authenticates the API when MCP_OAUTH is enabled', async () => {
    const owner = await signUpUser(app, 'PAT Coexist');
    const ws = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers: authed(owner.token),
        payload: { name: 'PAT ws' },
      })
    ).json().id as string;

    const pat = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: authed(owner.token),
        payload: { name: 'pat', workspace_id: ws },
      })
    ).json().token as string;
    expect(pat).toMatch(/^mn_pat_/);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ws}/databases`,
      headers: authed(pat),
    });
    expect(res.statusCode, 'enabling MCP_OAUTH must not displace PAT auth').toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(pat) });
    expect(me.statusCode).toBe(200);
    expect(me.json().auth.via).toBe('token');
  });
});
