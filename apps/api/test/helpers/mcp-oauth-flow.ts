import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { approveAuthorize } from './oauth-consent';

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Connect an MCP client the way claude.ai does: register a client, then the authorization-code + PKCE flow, as `sessionToken`'s user.
 * Needs `./enable-mcp-oauth` imported FIRST in the test file (MCP_OAUTH is read when the app module loads). Returns the token response.
 */
export async function connectMcpClient(app: NestFastifyApplication, sessionToken: string): Promise<Record<string, unknown>> {
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/register',
    payload: { redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], client_name: 'test-connector' },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const clientId = reg.json().client_id as string;
  const disc = await app.inject({ method: 'GET', url: '/api/v1/auth/.well-known/oauth-authorization-server' });
  const scope = (disc.json().scopes_supported as string[]).join(' ');
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://example.com/cb', scope, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
  const authRes = await app.inject({ method: 'GET', url: `/api/v1/auth/mcp/authorize?${q}`, headers: { authorization: `Bearer ${sessionToken}` } });
  expect(authRes.statusCode).toBe(302);
  // #1030: authorize now sends the person to the consent page; this is them pressing Allow (for their first workspace).
  const approved = await approveAuthorize(app, sessionToken, String(authRes.headers.location));
  const code = new URL(approved).searchParams.get('code')!;
  const tok = await app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://example.com/cb', client_id: clientId, code_verifier: verifier }).toString(),
  });
  expect(tok.statusCode, tok.body).toBe(200);
  return tok.json();
}
