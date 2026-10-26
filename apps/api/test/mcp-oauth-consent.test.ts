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
import { MAX_REGISTERED_REDIRECTS } from '../src/auth/loopback-redirect';

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

describe('#1030 loopback redirects may differ by PORT only (RFC 8252 §7.3)', () => {
  const loopbackClient = async (uri: string) => {
    const res = await register(uri, 'CLI');
    expect(res.statusCode, res.body).toBe(201);
    return res.json().client_id as string;
  };
  const authorizeAt = async (sessionToken: string, clientId: string, redirectUri: string) => {
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid offline_access', state: 'cli', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/auth/mcp/authorize?${q}`, headers: { authorization: `Bearer ${sessionToken}` } });
    return { res, verifier };
  };

  it('a CLI that registered one port and now listens on another completes the whole flow on the NEW port', async () => {
    const u = (await signUpUser(app, 'Loopback CLI')).token;
    const ws = await workspace(u, 'CLI WS');
    const clientId = await loopbackClient('http://127.0.0.1:1111/callback');
    const fresh = 'http://127.0.0.1:54321/callback';
    const { res, verifier } = await authorizeAt(u, clientId, fresh);
    expect(res.statusCode, res.body).toBe(302);
    expect(String(res.headers.location)).toMatch(/\/oauth\/consent\?/);
    const decided = await as(u, 'POST', '/oauth/consent', { consent_code: consentCodeOf(String(res.headers.location)), decision: 'allow', workspace_id: ws });
    const back = new URL(decided.json().redirect_url);
    expect(`${back.origin}${back.pathname}`, 'the code goes to the port the client is actually listening on').toBe(fresh);
    const tok = await app.inject({
      method: 'POST', url: '/api/v1/auth/mcp/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: fresh, client_id: clientId, code_verifier: verifier }).toString(),
    });
    expect(tok.statusCode, tok.body).toBe(200);
  });

  it.each([
    ['http://127.0.0.1:2222/other', 'a different PATH'],
    ['http://127.0.0.1:2222/callback?x=1', 'a different query'],
    ['http://localhost:2222/callback', 'a different loopback HOST (127.0.0.1 vs localhost)'],
    ['https://127.0.0.1:2222/callback', 'a different scheme'],
    ['http://evil.example:2222/callback', 'a non-loopback host'],
    ['http://127.0.0.1.evil.example:2222/callback', 'a loopback-looking host'],
    ['http://user@127.0.0.1:2222/callback', 'credentials'],
  ])('%s is refused (%s): only the port may vary', async (uri) => {
    const u = (await signUpUser(app, 'Loopback Strict')).token;
    const clientId = await loopbackClient('http://127.0.0.1:1111/callback');
    const { res } = await authorizeAt(u, clientId, uri);
    expect(res.statusCode, res.body).toBe(400);
  });

  it('a non-loopback client gets NO port flexibility (https://example.com:444 stays refused), and a hosted client is untouched', async () => {
    const u = (await signUpUser(app, 'Not Loopback')).token;
    const clientId = await client();
    expect((await authorizeAt(u, clientId, 'https://example.com:444/cb')).res.statusCode).toBe(400);
  });

  it('the registered list is bounded: a client cycling ports stops growing at the cap', async () => {
    const u = (await signUpUser(app, 'Port Cycler')).token;
    const clientId = await loopbackClient('http://127.0.0.1:1111/callback');
    for (let port = 3000; port < 3000 + MAX_REGISTERED_REDIRECTS + 5; port++) await authorizeAt(u, clientId, `http://127.0.0.1:${port}/callback`);
    const row = ((await db.execute(sql`SELECT redirect_urls FROM oauth_application WHERE client_id = ${clientId}`)) as unknown as { rows: Array<{ redirect_urls: string }> }).rows[0]!;
    expect(row.redirect_urls.split(',').length).toBe(MAX_REGISTERED_REDIRECTS);
  });
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
    expect(d.access_options, '#1079: there is no access level to choose').toBeUndefined();
  });

  it('someone else\'s code, an unknown code and an expired code never describe or decide anything', async () => {
    const owner = (await signUpUser(app, 'Code Owner')).token;
    const other = (await signUpUser(app, 'Other Person')).token;
    const ownerWs = await workspace(owner, 'Owner WS');
    const { location } = await authorize(owner, await client());
    const code = consentCodeOf(location);
    expect((await as(other, 'GET', `/oauth/consent?consent_code=${code}`)).statusCode, 'another person: 404').toBe(404);
    expect((await as(other, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: await workspace(other, 'Other WS') })).statusCode).toBe(404);
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

  it('Allow names only a workspace the person is a member of (or none = all), and cannot be answered twice', async () => {
    const u = (await signUpUser(app, 'Allower')).token;
    const stranger = (await signUpUser(app, 'Stranger')).token;
    const mine = await workspace(u, 'Allow WS');
    const theirs = await workspace(stranger, 'Not mine');
    const { location } = await authorize(u, await client());
    const code = consentCodeOf(location);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: theirs })).statusCode, 'a workspace they are not in').toBe(404);
    const ok = await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: mine });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(new URL(ok.json().redirect_url).searchParams.get('code')).toBe(code);
    expect((await as(u, 'POST', '/oauth/consent', { consent_code: code, decision: 'allow', workspace_id: mine })).statusCode, 'already answered').toBe(410);
  });
});

describe('#1030 an approved token reaches only what was approved', () => {
  async function connect(sessionToken: string, workspaceId: string | null) {
    const clientId = await client();
    const { location, verifier } = await authorize(sessionToken, clientId);
    const decided = await as(sessionToken, 'POST', '/oauth/consent', { consent_code: consentCodeOf(location), decision: 'allow', ...(workspaceId ? { workspace_id: workspaceId } : {}) });
    expect(decided.statusCode, decided.body).toBe(201);
    const tok = await exchange(clientId, new URL(decided.json().redirect_url).searchParams.get('code')!, verifier);
    expect(tok.statusCode, tok.body).toBe(200);
    return { token: tok.json().access_token as string, clientId };
  }

  it('bound to ONE of the victim\'s workspaces: the other is a 404, and discovery lists only the approved one', async () => {
    const victim = (await signUpUser(app, 'Two Workspaces')).token;
    const approved = await workspace(victim, 'Approved WS');
    const secret = await workspace(victim, 'Secret WS');
    const { token } = await connect(victim, approved);
    expect((await bearer(token, 'GET', `/workspaces/${approved}/databases`)).statusCode).toBe(200);
    const blocked = await bearer(token, 'GET', `/workspaces/${secret}/databases`);
    expect(blocked.statusCode, 'the attacker\'s token cannot even see the other workspace exists').toBe(404);
    expect((await bearer(token, 'POST', `/workspaces/${secret}/skills`, skill('planted'))).statusCode).toBe(404);
    const listed = (await bearer(token, 'GET', '/workspaces')).json() as Array<{ id: string }>;
    expect(listed.map((w) => w.id)).toEqual([approved]);
    const skills = (await as(victim, 'GET', `/workspaces/${secret}/skills`)).json() as { data?: Array<{ name: string }> };
    expect((skills.data ?? []).map((s) => s.name), 'nothing was planted in the victim\'s other workspace').not.toContain('planted');
  });

  it('#1079 there is no read-only level: a connection writes, and an `access` field sent by an old client changes nothing', async () => {
    const u = (await signUpUser(app, 'No Ceiling')).token;
    const ws = await workspace(u, 'No Ceiling WS');
    const clientId = await client();
    const { location, verifier } = await authorize(u, clientId);
    const decided = await as(u, 'POST', '/oauth/consent', { consent_code: consentCodeOf(location), decision: 'allow', workspace_id: ws, access: 'read' });
    expect(decided.statusCode, decided.body).toBe(201);
    const tok = await exchange(clientId, new URL(decided.json().redirect_url).searchParams.get('code')!, verifier);
    expect((await bearer(tok.json().access_token, 'POST', `/workspaces/${ws}/skills`, skill('writes'))).statusCode).toBe(201);
    const row = ((await db.execute(sql`SELECT scopes FROM oauth_consent WHERE client_id = ${clientId}`)) as unknown as { rows: Array<{ scopes: string }> }).rows[0]!;
    expect(row.scopes, 'no access word is stored').not.toContain('access:');
  });

  it('#1079 ALL workspaces is the default: omit workspace_id and every workspace the person is in is reachable, including one created later', async () => {
    const u = (await signUpUser(app, 'All Workspaces')).token;
    const first = await workspace(u, 'All First');
    const second = await workspace(u, 'All Second');
    const { token } = await connect(u, null);
    expect((await bearer(token, 'GET', `/workspaces/${first}/databases`)).statusCode).toBe(200);
    expect((await bearer(token, 'GET', `/workspaces/${second}/databases`)).statusCode).toBe(200);
    expect(((await bearer(token, 'GET', '/workspaces')).json() as Array<{ id: string }>).map((w) => w.id).sort()).toEqual([first, second].sort());
    const later = await workspace(u, 'All Later');
    expect((await bearer(token, 'GET', `/workspaces/${later}/databases`)).statusCode, 'a workspace joined after connecting is reachable').toBe(200);
    expect((await bearer(token, 'POST', `/workspaces/${later}/skills`, skill('anywhere'))).statusCode).toBe(201);
  });

  it('#1079 all workspaces is still bounded by membership: a workspace the person is NOT in is a 404, and one they leave stops working', async () => {
    const u = (await signUpUser(app, 'All Bounded')).token;
    const stranger = (await signUpUser(app, 'Stranger')).token;
    const mine = await workspace(u, 'Bounded Mine');
    const theirs = await workspace(stranger, 'Not Mine');
    const { token } = await connect(u, null);
    expect((await bearer(token, 'GET', `/workspaces/${theirs}/databases`)).statusCode).toBe(404);
    expect((await bearer(token, 'GET', `/workspaces/${mine}/databases`)).statusCode).toBe(200);
    await db.execute(sql`DELETE FROM memberships WHERE workspace_id = ${mine}`);
    expect((await bearer(token, 'GET', `/workspaces/${mine}/databases`)).statusCode, 'a workspace the person left is no longer reachable').toBe(404);
  });

  it("#1079 my AI, my rules: an ADMIN's connection reaches the schema/admin routes (create_database, add_field, the audit log); a MEMBER's is refused by their ROLE, not by a token ceiling", async () => {
    const admin = (await signUpUser(app, 'Rules Admin')).token;
    const member = await signUpUser(app, 'Rules Member');
    const ws = await workspace(admin, 'Rules WS');
    const space = (await as(admin, 'POST', `/workspaces/${ws}/spaces`, { name: 'Work' })).json().id as string;
    const inv = await as(admin, 'POST', `/workspaces/${ws}/invites`, { email: member.email, role: 'member' });
    await as(member.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });

    const a = await connect(admin, null);
    const m = await connect(member.token, null);
    // The token carries no scope: it is the person, like a session.
    expect((await bearer(a.token, 'GET', '/me')).json().auth).toMatchObject({ via: 'oauth', token_scope: null });
    expect((await bearer(m.token, 'GET', '/me')).json().auth).toMatchObject({ via: 'oauth', token_scope: null });

    expect((await bearer(a.token, 'GET', `/workspaces/${ws}/audit-log`)).statusCode, 'admin: admin-role route').toBe(200);
    const db = await bearer(a.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Made by admin AI' });
    expect(db.statusCode, db.body).toBe(201);
    const field = await bearer(a.token, 'POST', `/workspaces/${ws}/databases/${db.json().id}/fields`, { display_name: 'Notes', type: 'text', config: {} });
    expect(field.statusCode, field.body).toBe(201);

    const refused = await bearer(m.token, 'GET', `/workspaces/${ws}/audit-log`);
    expect(refused.statusCode, 'member: the ROLE refuses').toBe(403);
    expect(refused.body, 'and it says why in role terms, not "token is write-scoped"').not.toContain('-scoped');
    // Same answer as the member's own session: the connection has exactly the person's reach, no more and no less.
    const invitePayload = { email: 'someone-new@example.com', role: 'member' };
    const bySession = await as(member.token, 'POST', `/workspaces/${ws}/invites`, invitePayload);
    const byAi = await bearer(m.token, 'POST', `/workspaces/${ws}/invites`, invitePayload);
    expect(bySession.statusCode, 'a member cannot invite').toBe(403);
    expect(byAi.statusCode, "and neither can the member's AI").toBe(403);
    expect((await bearer(a.token, 'POST', `/workspaces/${ws}/invites`, invitePayload)).statusCode, "the admin's AI can").toBeLessThan(300);
  });

  it('#1079 an OAuth connection still cannot do an account-level (session-only) thing, e.g. create a workspace', async () => {
    const u = (await signUpUser(app, 'Session Only')).token;
    await workspace(u, 'SO WS');
    const { token } = await connect(u, null);
    expect((await bearer(token, 'POST', '/workspaces', { name: 'By an AI' })).statusCode).toBe(403);
  });

  it('#1079 an old READ-ONLY grant is not upgraded: it is refused until the client reconnects; an old WRITE grant still works', async () => {
    const u = (await signUpUser(app, 'Legacy')).token;
    const ws = await workspace(u, 'Legacy WS');
    const readCid = (await connect(u, ws)).clientId;
    const { token: writeToken, clientId: writeCid } = await connect(u, ws);
    await db.execute(sql`UPDATE oauth_consent SET scopes = ${`openid ws:${ws} access:read`} WHERE client_id = ${readCid}`);
    await db.execute(sql`UPDATE oauth_consent SET scopes = ${`openid ws:${ws} access:write`} WHERE client_id = ${writeCid}`);
    expect((await bearer(writeToken, 'POST', `/workspaces/${ws}/skills`, skill('legacy-write'))).statusCode).toBe(201);
    const tokens = ((await db.execute(sql`SELECT access_token FROM oauth_access_token WHERE client_id = ${readCid}`)) as unknown as { rows: Array<{ access_token: string }> }).rows;
    const refused = await bearer(tokens[0]!.access_token, 'GET', `/workspaces/${ws}/spaces`);
    expect(refused.statusCode).toBe(401);
    expect(refused.body).toContain('Reconnect');
  });

  it('/me reports the grant, so a client can say what it is allowed', async () => {
    const u = (await signUpUser(app, 'Me Reports')).token;
    const ws = await workspace(u, 'Me WS');
    const { token } = await connect(u, ws);
    const me = (await bearer(token, 'GET', '/me')).json();
    expect(me.auth).toMatchObject({ via: 'oauth', token_scope: null });
  });

  it('a connection with NO grant is refused: a consent row deleted (disconnect) or never written (made before consent existed)', async () => {
    const u = (await signUpUser(app, 'No Grant')).token;
    const ws = await workspace(u, 'No Grant WS');
    const { token, clientId } = await connect(u, ws);
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
      const d = await as(u, 'POST', '/oauth/consent', { consent_code: consentCodeOf(location), decision: 'allow', workspace_id: ws });
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
    const s = formatGrantScopes(['openid', 'ws:11111111-1111-1111-1111-111111111111', 'access:write'], { workspaceId: ws });
    expect(parseGrantScopes(s)).toEqual({ workspaceId: ws });
    expect(s, 'a client-supplied ws: scope word cannot survive formatting').not.toContain('11111111');
    expect(s, 'and no access word is ever written (#1079)').not.toContain('access:');
    expect(parseGrantScopes(formatGrantScopes(['openid'], { workspaceId: null }))).toEqual({ workspaceId: null });
    expect(formatGrantScopes(['openid'], { workspaceId: null })).toContain('ws:all');
    expect(parseGrantScopes(`openid ws:${ws} access:write`), 'a pre-#1079 write row stays valid').toEqual({ workspaceId: ws });
    for (const bad of [null, '', 'openid offline_access', `access:write`, `ws:not-a-uuid`, `ws:${ws} access:read`, 'ws:all access:read', 'ws:ALLX']) expect(parseGrantScopes(bad), String(bad)).toBeNull();
  });
});
