// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { redirectUriAllowed, parseRedirectAllowlist, firstDisallowedRedirect, DEFAULT_REDIRECT_HOSTS } from '../src/auth/mcp-oauth-policy';
import { formatGrantScopes, parseGrantScopes } from '../src/auth/oauth-grant';

/**
 * #1030 — hosted-MCP OAuth gave a victim's whole account to whoever registered a client: registration was open, authorize
 * issued a code with no consent unless the CLIENT asked for one, and the token then worked in every workspace at full power.
 * Each test attacks as the attacker and checks what the victim's account actually lost or kept.
 */
const b64url = (b: Buffer) => b.toString('base64url');
const REDIRECT = 'https://example.com/cb'; // allowed in this suite by helpers/enable-mcp-oauth (MCP_OAUTH_REDIRECT_HOSTS)
const { db } = connectTestDb();
let app: NestFastifyApplication;

beforeAll(async () => { app = await createTestApp(); }, 120_000);
afterAll(async () => { await app.close(); restoreMcpOAuth(); });

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const bearer = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

async function register(redirectUri = REDIRECT, name = 'evil-or-not') {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/register',
    payload: { redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], client_name: name },
  });
}
async function client(name = 'Test Connector') {
  const res = await register(REDIRECT, name);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().client_id as string;
}
/** The attacker's link, followed by the victim's logged-in browser. `extra` lets the attacker add or omit `prompt`. */
async function authorize(sessionToken: string, clientId: string, extra: Record<string, string> = {}) {
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid offline_access storyos.mcp',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 'st-1', ...extra,
  });
  const res = await app.inject({ method: 'GET', url: `/api/v1/auth/mcp/authorize?${q}`, headers: { authorization: `Bearer ${sessionToken}` } });
  expect(res.statusCode).toBe(302);
  return { location: String(res.headers.location), verifier };
}
const exchange = (clientId: string, code: string, verifier: string) =>
  app.inject({
    method: 'POST', url: '/api/v1/auth/mcp/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString(),
  });
const consentCodeOf = (location: string) => new URL(location).searchParams.get('consent_code')!;
const skill = (name: string) => ({ name, description: 'd', when_to_use: 'w', instructions: 'i' });
const workspace = async (token: string, name: string) => (await as(token, 'POST', '/workspaces', { name })).json().id as string;

describe('#1030 registration only accepts redirect URIs a real AI client uses', () => {
  it.each([
    ['https://evil.example/cb'], ['http://evil.example/cb'], ['javascript:alert(1)'], ['data:text/html,x'], ['https://claude.ai.evil.example/cb'],
    ['https://user:pw@claude.ai/cb'], ['https://claude.ai/cb#frag'], ['file:///etc/passwd'], ['not a url'], ['http://claude.ai/cb'],
    ['vbscript:msgbox(1)'], ['blob:https://claude.ai/abc'], ['JAVASCRIPT:alert(1)'],
  ])('refuses %s with invalid_redirect_uri and creates no client', async (uri) => {
    const before = ((await db.execute(sql`SELECT count(*)::int AS n FROM oauth_application`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    const res = await register(uri);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('invalid_redirect_uri');
    const after = ((await db.execute(sql`SELECT count(*)::int AS n FROM oauth_application`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(after, 'nothing was registered').toBe(before);
  });

  it('a body with no redirect_uris, or an evil one hidden among good ones, is refused', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/mcp/register', payload: { client_name: 'x' } })).statusCode).toBe(400);
    const mixed = await app.inject({ method: 'POST', url: '/api/v1/auth/mcp/register', payload: { redirect_uris: [REDIRECT, 'https://evil.example/cb'], client_name: 'x' } });
    expect(mixed.statusCode).toBe(400);
  });

  it('real clients still register: a hosted AI host, a loopback port, and an operator-added host', async () => {
    for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'http://127.0.0.1:53682/callback', 'http://localhost:8123/cb', 'cursor://anysphere.cursor-retrieval/oauth/callback', 'vscode://ms-vscode.mcp/auth', REDIRECT]) {
      const res = await register(uri);
      expect(res.statusCode, `${uri}: ${res.body}`).toBe(201);
    }
  });
});

describe('#1030 authorize never issues a code without the person deciding', () => {
  it('the ONE-CLICK attack: a logged-in victim following the attacker\'s link (no prompt) lands on the consent page, and no code reaches the client', async () => {
    const victim = (await signUpUser(app, 'Consent Victim')).token;
    const clientId = await client('Totally Legit');
    const { location } = await authorize(victim, clientId); // the attacker omits `prompt`
    const to = new URL(location);
    expect(`${to.origin}${to.pathname}`, 'sent to OUR consent page').toMatch(/\/oauth\/consent$/);
    expect(to.searchParams.get('consent_code')).toBeTruthy();
    expect(location, 'the client\'s redirect URI was not reached').not.toContain(REDIRECT);
    expect(to.searchParams.get('code')).toBeNull();
    // the attacker cannot switch it off by saying so
    for (const prompt of ['none', 'login', '', 'select_account']) {
      const again = await authorize(victim, clientId, { prompt });
      expect(again.location, `prompt=${prompt}`).toMatch(/\/oauth\/consent\?/);
      expect(again.location).not.toContain(REDIRECT);
    }
  });

  it('a code exchanged BEFORE consent (it would be known only to whoever saw the consent URL) gives a token that does nothing', async () => {
    const victim = (await signUpUser(app, 'Early Exchange')).token;
    await workspace(victim, 'Early WS');
    const clientId = await client();
    const { location, verifier } = await authorize(victim, clientId);
    const tok = await exchange(clientId, consentCodeOf(location), verifier);
    expect(tok.statusCode, 'the plugin itself does not check consent at the token step').toBe(200);
    const me = await bearer(tok.json().access_token, 'GET', '/me');
    expect(me.statusCode, 'but with no grant the token is refused').toBe(401);
    expect(me.body).toContain('has not been approved');
  });
});

describe('#1030 the redirect URI at authorize must EXACT-match a registered one', () => {
  it.each([['https://example.com/cb/evil'], ['https://example.com/cb?x=1'], ['https://example.com/'], ['https://example.com:444/cb'], ['https://example.com.evil.example/cb'], ['https://EXAMPLE.com/cb/']])(
    'a registered https://example.com/cb does not authorize %s: no consent code, no redirect',
    async (uri) => {
      const victim = (await signUpUser(app, 'Exact Match')).token;
      const clientId = await client();
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: uri, scope: 'openid', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      const res = await app.inject({ method: 'GET', url: `/api/v1/auth/mcp/authorize?${q}`, headers: { authorization: `Bearer ${victim}` } });
      expect(res.statusCode, res.body).toBe(400);
      expect(String(res.headers.location ?? '')).not.toContain('consent_code');
    },
  );
});

describe('#1030 the consent screen', () => {
  it('describes the request: client name, the host it redirects to, plain-language scopes, and the workspaces you can bind it to', async () => {
    const victim = (await signUpUser(app, 'Describe User')).token;
    const ws = await workspace(victim, 'Describe WS');
    const { location } = await authorize(victim, await client('Acme Assistant'));
    const res = await as(victim, 'GET', `/oauth/consent?consent_code=${consentCodeOf(location)}`);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.client_name).toBe('Acme Assistant');
    expect(d.redirect_host).toBe('example.com');
    expect(d.scopes.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['openid', 'storyos.mcp']));
    expect(d.scopes.find((s: { id: string }) => s.id === 'storyos.mcp').label).not.toBe('storyos.mcp');
    expect(d.workspaces.map((w: { id: string }) => w.id)).toContain(ws);
    expect(d.access_options).toEqual(['read', 'write']);
  });

  it('someone else\'s code, an unknown code and an expired code never describe or decide anything', async () => {
    const owner = (await signUpUser(app, 'Code Owner')).token;
    const other = (await signUpUser(app, 'Other Person')).token;
    const ownerWs = await workspace(owner, 'Owner WS');
    const { location } = await authorize(owner, await client());
    const code = consentCodeOf(location);
    expect((await as(other, 'GET', `/oauth/consent?consent_code=${code}`)).statusCode, 'another person: 404').toBe(404);
    expect((await as(other, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: await workspace(other, 'Other WS'), access: 'write' })).statusCode).toBe(404);
    expect((await as(owner, 'GET', '/oauth/consent?consent_code=does-not-exist-123')).statusCode).toBe(404);
    await db.execute(sql`UPDATE verification SET expires_at = now() - interval '1 minute' WHERE identifier = ${code}`);
    expect((await as(owner, 'GET', `/oauth/consent?consent_code=${code}`)).statusCode, 'expired: 410').toBe(410);
    expect((await as(owner, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: ownerWs })).statusCode).toBe(410);
  });

  it('only a PERSON can decide: an API token and an OAuth token are refused', async () => {
    const u = (await signUpUser(app, 'Decider')).token;
    const ws = await workspace(u, 'Decider WS');
    const { location } = await authorize(u, await client());
    const code = consentCodeOf(location);
    const pat = (await as(u, 'POST', '/me/tokens', { name: 'p', workspace_id: ws })).json().token as string;
    expect((await bearer(pat, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: ws })).statusCode).toBe(403);
    expect((await bearer(pat, 'GET', `/oauth/consent?consent_code=${code}`)).statusCode).toBe(403);
  });

  it('Deny sends the client access_denied with its state, no code, and the request is gone', async () => {
    const u = (await signUpUser(app, 'Denier')).token;
    await workspace(u, 'Deny WS');
    const clientId = await client();
    const { location, verifier } = await authorize(u, clientId);
    const code = consentCodeOf(location);
    const denied = await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'deny' });
    expect(denied.statusCode, denied.body).toBe(201);
    const back = new URL(denied.json().redirect_url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('code')).toBeNull();
    expect((await exchange(clientId, code, verifier)).statusCode, 'the code no longer exists').toBe(401);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: await workspace(u, 'x') })).statusCode).toBe(404);
  });

  it('Allow needs a workspace the person is a member of, and cannot be answered twice', async () => {
    const u = (await signUpUser(app, 'Allower')).token;
    const stranger = (await signUpUser(app, 'Stranger')).token;
    const mine = await workspace(u, 'Allow WS');
    const theirs = await workspace(stranger, 'Not mine');
    const { location } = await authorize(u, await client());
    const code = consentCodeOf(location);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow' })).statusCode, 'no workspace chosen').toBe(422);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: theirs })).statusCode, 'a workspace they are not in').toBe(404);
    const ok = await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: mine, access: 'read' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(new URL(ok.json().redirect_url).searchParams.get('code')).toBe(code);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: mine })).statusCode, 'already answered').toBe(410);
  });
});

describe('#1030 an approved token reaches only what was approved', () => {
  async function connect(sessionToken: string, workspaceId: string, access: 'read' | 'write') {
    const clientId = await client();
    const { location, verifier } = await authorize(sessionToken, clientId);
    const decided = await as(sessionToken, 'POST', '/oauth/consent', { consent_code: consentCodeOf(location), decision: 'allow', workspace_id: workspaceId, access });
    expect(decided.statusCode, decided.body).toBe(201);
    const tok = await exchange(clientId, new URL(decided.json().redirect_url).searchParams.get('code')!, verifier);
    expect(tok.statusCode, tok.body).toBe(200);
    return { token: tok.json().access_token as string, clientId };
  }

  it('bound to ONE of the victim\'s workspaces: the other is a 404, and discovery lists only the approved one', async () => {
    const victim = (await signUpUser(app, 'Two Workspaces')).token;
    const approved = await workspace(victim, 'Approved WS');
    const secret = await workspace(victim, 'Secret WS');
    const { token } = await connect(victim, approved, 'write');
    expect((await bearer(token, 'GET', `/workspaces/${approved}/databases`)).statusCode).toBe(200);
    const blocked = await bearer(token, 'GET', `/workspaces/${secret}/databases`);
    expect(blocked.statusCode, 'the attacker\'s token cannot even see the other workspace exists').toBe(404);
    expect((await bearer(token, 'POST', `/workspaces/${secret}/skills`, skill('planted'))).statusCode).toBe(404);
    const listed = (await bearer(token, 'GET', '/workspaces')).json() as Array<{ id: string }>;
    expect(listed.map((w) => w.id)).toEqual([approved]);
    const skills = (await as(victim, 'GET', `/workspaces/${secret}/skills`)).json() as { data?: Array<{ name: string }> };
    expect((skills.data ?? []).map((s) => s.name), 'nothing was planted in the victim\'s other workspace').not.toContain('planted');
  });

  it('a READ grant cannot write; a WRITE grant can', async () => {
    const u = (await signUpUser(app, 'Ceiling')).token;
    const ws = await workspace(u, 'Ceiling WS');
    const reader = await connect(u, ws, 'read');
    expect((await bearer(reader.token, 'GET', `/workspaces/${ws}/skills`)).statusCode).toBe(200);
    const denied = await bearer(reader.token, 'POST', `/workspaces/${ws}/skills`, skill('nope'));
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain('read-scoped');
    const writer = await connect(u, ws, 'write');
    expect((await bearer(writer.token, 'POST', `/workspaces/${ws}/skills`, skill('yes'))).statusCode).toBe(201);
  });

  it('/me reports the grant, so a client can say what it is allowed', async () => {
    const u = (await signUpUser(app, 'Me Reports')).token;
    const ws = await workspace(u, 'Me WS');
    const { token } = await connect(u, ws, 'read');
    const me = (await bearer(token, 'GET', '/me')).json();
    expect(me.auth).toMatchObject({ via: 'oauth', token_scope: 'read' });
  });

  it('a connection with NO grant is refused: a consent row deleted (disconnect) or never written (made before consent existed)', async () => {
    const u = (await signUpUser(app, 'No Grant')).token;
    const ws = await workspace(u, 'No Grant WS');
    const { token, clientId } = await connect(u, ws, 'write');
    expect((await bearer(token, 'GET', `/workspaces/${ws}/spaces`)).statusCode).toBe(200);
    await db.execute(sql`DELETE FROM oauth_consent WHERE client_id = ${clientId}`);
    const refused = await bearer(token, 'GET', `/workspaces/${ws}/spaces`);
    expect(refused.statusCode).toBe(401);
    expect(refused.body).toContain('Reconnect');
  });

  it('approving the same client again REPLACES the grant (one workspace at a time), it never accumulates', async () => {
    const u = (await signUpUser(app, 'Replace')).token;
    const a = await workspace(u, 'First WS');
    const b = await workspace(u, 'Second WS');
    const clientId = await client();
    const run = async (ws: string) => {
      const { location, verifier } = await authorize(u, clientId);
      const d = await as(u, 'POST', '/oauth/consent', { consent_code: consentCodeOf(location), decision: 'allow', workspace_id: ws, access: 'write' });
      return exchange(clientId, new URL(d.json().redirect_url).searchParams.get('code')!, verifier);
    };
    const first = (await run(a)).json().access_token as string;
    const second = (await run(b)).json().access_token as string;
    const rows = ((await db.execute(sql`SELECT count(*)::int AS n FROM oauth_consent WHERE client_id = ${clientId}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(rows).toBe(1);
    expect((await bearer(second, 'GET', `/workspaces/${b}/spaces`)).statusCode).toBe(200);
    expect((await bearer(first, 'GET', `/workspaces/${a}/spaces`)).statusCode, 'the older token follows the newer grant').toBe(404);
  });
});

describe('#1030 policy and grant encoding (pure)', () => {
  const none = { hosts: [] as string[] };
  it('redirectUriAllowed: built-in hosts, loopback, native custom schemes, operator additions; everything else out', () => {
    for (const h of DEFAULT_REDIRECT_HOSTS) expect(redirectUriAllowed(`https://${h}/cb`, none), h).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:9999/cb', none)).toBe(true);
    expect(redirectUriAllowed('http://[::1]:9999/cb', none)).toBe(true);
    expect(redirectUriAllowed('http://localhost/cb', none)).toBe(true);
    expect(redirectUriAllowed('https://localhost/cb', none), 'https to localhost is not an allowlisted host').toBe(false);
    expect(redirectUriAllowed('https://example.com/cb', none)).toBe(false);
    expect(redirectUriAllowed('https://example.com/cb', parseRedirectAllowlist('example.com'))).toBe(true);
    for (const ok of ['cursor://anysphere.cursor/cb', 'vscode://x/cb', 'vscode-insiders://x/cb']) expect(redirectUriAllowed(ok, none), ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'blob:https://claude.ai/x']) expect(redirectUriAllowed(bad, none), bad).toBe(false);
  });
  it('firstDisallowedRedirect treats anything that is not a list of strings as a failure', () => {
    expect(firstDisallowedRedirect({}, none)).not.toBeNull();
    expect(firstDisallowedRedirect({ redirect_uris: [] }, none)).not.toBeNull();
    expect(firstDisallowedRedirect({ redirect_uris: 'https://claude.ai/cb' }, none)).not.toBeNull();
    expect(firstDisallowedRedirect({ redirect_uris: [5] }, none)).not.toBeNull();
    expect(firstDisallowedRedirect({ redirect_uris: ['https://claude.ai/cb'] }, none)).toBeNull();
  });
  it('a grant round-trips through the consent row\'s scopes, and anything malformed parses to NO grant', () => {
    const ws = '3448c14b-70f3-41bc-9188-839029be9f7e';
    const s = formatGrantScopes(['openid', 'ws:11111111-1111-1111-1111-111111111111'], { workspaceId: ws, access: 'write' });
    expect(parseGrantScopes(s)).toEqual({ workspaceId: ws, access: 'write' });
    expect(s, 'a client-supplied ws: scope word cannot survive formatting').not.toContain('11111111');
    for (const bad of [null, '', 'openid offline_access', `ws:${ws}`, `access:write`, `ws:not-a-uuid access:write`, `ws:${ws} access:admin`]) expect(parseGrantScopes(bad), String(bad)).toBeNull();
  });
});
