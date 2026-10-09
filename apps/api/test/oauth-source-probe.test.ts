// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #848 PROBE — what does the API think an AI connected through the hosted-MCP OAuth connector is?
 *
 * #442 / ADR-0010 rest on `req.auth.source`: an agent is non-human, so it may not publish a skill to
 * anyone else (`assertMayPublish`), and the #848 opt-in is "settable only from a human-sourced
 * request". The auth guard gives an OAuth access token (what claude.ai's connector uses in
 * production, per #331) `source: 'human'`. This measures what follows, with a PAT beside it as the
 * control: a PAT is `mcp`, so the gate holds for it.
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


const b64 = b64url; void b64;

describe('#848 probe: OAuth-connected AI vs a PAT', () => {
  it('the same calls, as an OAuth token and as a PAT', async () => {
    const { token: session } = await signUpUser(app, 'OAuth Probe Admin');
    const as = (token: string, method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
    const wsId = (await as(session, 'POST', '/workspaces', { name: 'oauth probe' })).json().id as string;

    const clientId = await registerClient();
    const { token } = await runOAuthFlow(session, clientId);
    const oauth = String(token!.access_token);
    const pat = (await as(session, 'POST', '/me/tokens', { name: 'probe-pat', workspace_id: wsId })).json().token as string;

    const me = (t: string) => as(t, 'GET', '/me').then((r) => r.json().auth);
    process.stderr.write(`PROBE auth oauth=${JSON.stringify(await me(oauth))} pat=${JSON.stringify(await me(pat))}\n`);

    const skill = (name: string, extra: Record<string, unknown> = {}) => ({
      name, description: 'd', when_to_use: 'w', instructions: 'i', ...extra,
    });
    for (const [label, t] of [['OAUTH', oauth], ['PAT', pat]] as const) {
      const dflt = await as(t, 'POST', `/workspaces/${wsId}/skills`, skill(`${label} default`));
      const shared = await as(t, 'POST', `/workspaces/${wsId}/skills`, skill(`${label} shared`, { visibility: 'shared' }));
      const pub = await as(t, 'POST', `/workspaces/${wsId}/skills`, skill(`${label} public`, { visibility: 'public' }));
      const flag = await as(t, 'PATCH', `/workspaces/${wsId}`, { private_attachments: true });
      process.stderr.write(
        `PROBE ${label}: omitted->${dflt.statusCode}/${dflt.json().visibility}/source=${dflt.json().source} ` +
          `shared->${shared.statusCode} public->${pub.statusCode} workspaceFlagPATCH->${flag.statusCode}\n`,
      );
    }
    expect(true).toBe(true);
  });
});
