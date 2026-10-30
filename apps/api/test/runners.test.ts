import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { ABSENT, shape } from './helpers/route-sweep';
import { connectTestDb } from './helpers/db';
import { RunnersService } from '../src/runners/runners.service';
import { RunnerSweeperService } from '../src/runners/runner-sweeper.service';
import { PAIRING_CODE_ALPHABET, RUNNER_OFFLINE_AFTER_MS } from '../src/runners/runner.constants';

/**
 * #1131 / ADR-0021 §3 + §11 — the Runner: pairing, the runner token, heartbeat, offline, owner-only list and remove, and the
 * agent assignment. Real fixtures for every kind of caller the ticket names: a member who owns a Runner, ANOTHER member, an ADMIN
 * (owner-only means admins too), a GUEST, no sign-in, a PAT, and a Runner token on routes that are not its own.
 */
let app: NestFastifyApplication;
let runnersSvc: RunnersService;
let sweeper: RunnerSweeperService;
let ws: string;
let agentsDbId: string;
let admin: { token: string; email: string };
let owner: Person; // a MEMBER who pairs a Runner
let other: Person; // another member
let guest: Person;
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }, { id: 'cursor', installed: false }];
const report = (over: Record<string, unknown> = {}) => ({ machine_name: "Marek's MacBook", tools: TOOLS, runner_version: '0.1.0', protocol_version: 1, ...over });

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });

async function issue(who: { token: string }) {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string; expires_at: string };
}

/** Pair a Runner for `who` up to the PENDING state: returns its token, id and the code that made it. */
async function pair(who: { token: string }, over: Record<string, unknown> = {}) {
  const code = await issue(who);
  const res = await asRunner(null, 'POST', '/runner/v1/pair', { code: code.code, ...report(over) });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { token: string; runner: { id: string } };
  return { token: body.token, id: body.runner.id, codeId: code.id, code: code.code };
}

/** Pair and press Done. */
async function pairActive(who: { token: string }, over: Record<string, unknown> = {}) {
  const r = await pair(who, over);
  const done = await as(who.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
  expect(done.statusCode, done.body).toBe(200);
  return r;
}

/** The Agents database's `AI mode` option ids by label (a record stores the option id). */
let aiModeIds: Record<string, string> = {};

async function createAgent(who: { token: string }, name: string, aiMode: string | null = 'Your own AI') {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
    values: { name, enabled: true, ...(aiMode ? { ai_mode: aiModeIds[aiMode] } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const row = async (id: string) => (await pool.query('select * from runners where id = $1', [id])).rows[0];

beforeAll(async () => {
  app = await createTestApp();
  runnersSvc = app.get(RunnersService);
  sweeper = app.get(RunnerSweeperService);
  admin = await signUpUser(app, 'RunnerAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Runner WS' })).json().id;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  owner = await joinAs(app, admin.token, ws, 'RunnerOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'RunnerOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'RunnerGuest', 'guest', [{ database_id: agentsDbId, role: 'viewer' }]);
}, 120_000);

beforeEach(async () => {
  // The lockout counts failures per address and every inject() is 127.0.0.1: start each test with a clean slate.
  await pool.query('delete from runner_pairing_failures');
  // ... and the per-person hourly cap on asking for codes is exercised by its own test, not by every test's fixtures.
  await pool.query("update runner_pairing_codes set created_at = created_at - interval '3 hours'");
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('pairing, end to end', () => {
  it('issues a 6-character code from the unambiguous alphabet that expires in about 10 minutes, and exchanges it for a PENDING Runner that Done turns on', async () => {
    const code = await issue(owner);
    expect(code.code).toMatch(/^[A-Z2-9]{6}$/);
    for (const ch of code.code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    expect(code.code).not.toMatch(/[01OIL]/);
    const minutes = (new Date(code.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.5);
    expect(minutes).toBeLessThanOrEqual(10);

    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${code.id}`)).json()).toMatchObject({ status: 'waiting' });

    const paired = await asRunner(null, 'POST', '/runner/v1/pair', { code: code.code, ...report() });
    expect(paired.statusCode, paired.body).toBe(201);
    const { token, runner } = paired.json();
    expect(token).toMatch(/^mn_run_/);
    expect(runner.status).toBe('pending');

    // The app's dialog sees "connected" with what the Runner found.
    const poll = (await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${code.id}`)).json();
    expect(poll.status).toBe('connected');
    expect(poll.runner.tools.map((t: { id: string }) => t.id)).toEqual(['claude-code', 'cursor']);

    // PENDING: the token authenticates (so the Runner can learn it is waiting) but it is told about no work.
    const hb = await asRunner(token, 'POST', '/runner/v1/heartbeat', report());
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json().runner.status).toBe('pending');
    expect(hb.json().assigned_agents).toEqual([]);
    const listed = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.find((r: { id: string }) => r.id === runner.id);
    expect(listed).toMatchObject({ status: 'pending', chosen_tool: null, connection: 'online' });
    expect(listed.pending_expires_at).toBeTruthy();

    // Done: the person's confirmation, with the tool agents should use.
    const done = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'active', chosen_tool: 'claude-code', connection: 'online', pending_expires_at: null });
    expect((await asRunner(token, 'POST', '/runner/v1/heartbeat', report())).json().runner.status).toBe('active');
  });

  it('stores neither the code nor the token in the clear', async () => {
    const r = await pair(owner);
    const stored = JSON.stringify((await pool.query('select * from runners where id = $1', [r.id])).rows[0]) + JSON.stringify((await pool.query('select * from runner_pairing_codes where id = $1', [r.codeId])).rows[0]);
    expect(stored).not.toContain(r.token);
    expect(stored).not.toContain(r.code);
    const rr = await row(r.id);
    expect(rr.token_prefix).toMatch(/^mn_run_.{4}….{4}$/);
    expect(rr.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a code works ONCE: a second exchange is refused, and two at the same instant make exactly one Runner', async () => {
    const r = await pair(owner);
    const again = await asRunner(null, 'POST', '/runner/v1/pair', { code: r.code, ...report() });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('code_already_used');

    const fresh = await issue(owner);
    const both = await Promise.all([1, 2].map(() => asRunner(null, 'POST', '/runner/v1/pair', { code: fresh.code, ...report() })));
    expect(both.map((x) => x.statusCode).sort()).toEqual([201, 409]);
    expect((await pool.query('select count(*)::int n from runners where pairing_code_id = $1', [fresh.id])).rows[0].n).toBe(1);
  });

  it('refuses an expired code, a cancelled code and a code burned by a newer one, each with its own sentence', async () => {
    const expired = await issue(owner);
    await pool.query("update runner_pairing_codes set expires_at = now() - interval '1 minute' where id = $1", [expired.id]);
    const e = await asRunner(null, 'POST', '/runner/v1/pair', { code: expired.code, ...report() });
    expect(e.statusCode).toBe(409);
    expect(e.json().error.code).toBe('pairing_expired');
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${expired.id}`)).json().status).toBe('expired');

    const cancelled = await issue(owner);
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/pairing-codes/${cancelled.id}`)).statusCode).toBe(204);
    const c = await asRunner(null, 'POST', '/runner/v1/pair', { code: cancelled.code, ...report() });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('pairing_cancelled');
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${cancelled.id}`)).json().status).toBe('cancelled');

    // One live code per person and workspace: asking for a new one burns the previous unused one.
    const first = await issue(owner);
    const second = await issue(owner);
    const burned = await asRunner(null, 'POST', '/runner/v1/pair', { code: first.code, ...report() });
    expect(burned.statusCode).toBe(409);
    expect(burned.json().error.code).toBe('pairing_cancelled');
    expect((await asRunner(null, 'POST', '/runner/v1/pair', { code: second.code, ...report() })).statusCode).toBe(201);
  });

  it('caps how many codes one person can ask for in an hour', async () => {
    const spammer = await joinAs(app, admin.token, ws, 'RunnerSpammer', 'member');
    for (let i = 0; i < 20; i++) await issue(spammer);
    const res = await as(spammer.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('pairing_codes_limit');
  });

  it('forgives case and a dash in what the person typed', async () => {
    const code = await issue(owner);
    const typed = `${code.code.slice(0, 3)}-${code.code.slice(3)}`.toLowerCase();
    expect((await asRunner(null, 'POST', '/runner/v1/pair', { code: typed, ...report() })).statusCode).toBe(201);
  });

  it('wrong guesses lock the address out, even for the RIGHT code, and a lockout does not touch a code that was never guessed', async () => {
    const live = await issue(owner);
    for (let i = 0; i < 5; i++) {
      const bad = await asRunner(null, 'POST', '/runner/v1/pair', { code: i % 2 ? 'ZZZZZZ' : 'nope', ...report() });
      expect(bad.statusCode, bad.body).toBe(422);
      expect(bad.json().error.code).toBe('invalid_code');
    }
    const locked = await asRunner(null, 'POST', '/runner/v1/pair', { code: live.code, ...report() });
    expect(locked.statusCode, locked.body).toBe(429);
    expect(locked.json().error.code).toBe('pairing_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // Once the window has passed the very same, still-unused code works.
    await pool.query("update runner_pairing_failures set created_at = now() - interval '11 minutes'");
    expect((await asRunner(null, 'POST', '/runner/v1/pair', { code: live.code, ...report() })).statusCode).toBe(201);
  });

  it('the global ceiling bounds a guesser who rotates addresses', async () => {
    const live = await issue(owner);
    await pool.query("insert into runner_pairing_failures (ip) select '10.9.' || (g % 250) || '.' || (g / 250) from generate_series(1, 300) g");
    const res = await asRunner(null, 'POST', '/runner/v1/pair', { code: live.code, ...report() });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error.code).toBe('pairing_busy');
  });

  it('Cancel revokes the PENDING Runner at once; its token gets the cancelled sentence, and a late Done is refused', async () => {
    const r = await pair(owner);
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/pairing-codes/${r.codeId}`)).statusCode).toBe(204);
    const hb = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect(hb.statusCode).toBe(401);
    expect(hb.json().error.code).toBe('runner_revoked');
    expect(hb.json().error.message).toContain('cancelled');
    expect(hb.json().error.message).toContain('storyos-runner pair');
    const late = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('pairing_cancelled');
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${r.codeId}`)).json().status).toBe('cancelled');
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.some((x: { id: string }) => x.id === r.id)).toBe(false);
  });

  it('Cancel after Done is a stale click and leaves the active Runner alone', async () => {
    const r = await pairActive(owner);
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/pairing-codes/${r.codeId}`)).statusCode).toBe(204);
    expect((await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report())).statusCode).toBe(200);
  });

  it('the pairing window expiring revokes the pending Runner: its token is refused at once, the sweeper makes it permanent, and a late Done is 409 pairing_expired', async () => {
    const r = await pair(owner);
    await pool.query("update runners set pending_expires_at = now() - interval '1 second' where id = $1", [r.id]);
    // Refused BEFORE the sweeper has run: the guard checks the window itself.
    const hb = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect(hb.statusCode).toBe(401);
    expect(hb.json().error.code).toBe('runner_revoked');
    expect(hb.json().error.message).toContain('pairing window');

    const swept = await sweeper.sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(await row(r.id)).toMatchObject({ status: 'revoked', revoked_reason: 'pairing_expired' });

    const late = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.code).toBe('pairing_expired');
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${r.codeId}`)).json().status).toBe('expired');
  });

  it('a late Done is 409 pairing_expired even when the sweeper has not run yet (and revokes it then)', async () => {
    const r = await pair(owner);
    await pool.query("update runners set pending_expires_at = now() - interval '1 second' where id = $1", [r.id]);
    const late = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.code).toBe('pairing_expired');
    expect((await row(r.id)).status).toBe('revoked');
  });

  it('Done refuses a tool the Runner did not find, and a Runner that is not pending', async () => {
    const r = await pair(owner);
    const missing = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'cursor' });
    expect(missing.statusCode, missing.body).toBe(422);
    expect((await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'nonsense' })).statusCode).toBe(422);
    expect((await row(r.id)).status).toBe('pending');
    expect((await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
    const twice = await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('not_pending');
  });

  it('PATCH changes the chosen tool only to one the Runner found, and only once it is on', async () => {
    const r = await pair(owner);
    expect((await as(owner.token, 'PATCH', `/workspaces/${ws}/runners/${r.id}`, { tool: 'claude-code' })).statusCode).toBe(409);
    await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' });
    expect((await as(owner.token, 'PATCH', `/workspaces/${ws}/runners/${r.id}`, { tool: 'cursor' })).statusCode).toBe(422);
    // The tool is later removed from the computer: the Runner reports it and the connection says so.
    await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report({ tools: [{ id: 'claude-code', installed: false }] }));
    const listed = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.find((x: { id: string }) => x.id === r.id);
    expect(listed.connection).toBe('tool_missing');
  });
});

describe('who may do what (real fixtures: owner, another member, an admin, a guest, no sign-in, a PAT, a Runner token)', () => {
  it('a guest is refused with the guest sentence; nobody signed in is 401', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toContain('Guests cannot pair a Runner');
    expect((await as(guest.token, 'GET', `/workspaces/${ws}/runners`)).statusCode).toBe(403);
    expect((await as(null, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).statusCode).toBe(401);
    expect((await as(null, 'GET', `/workspaces/${ws}/runners`)).statusCode).toBe(401);
  });

  it('a guest who somehow holds a pending code is refused at the exchange (their membership is checked then, not only at issue)', async () => {
    // A member issues a code, then an admin demotes them to a guest before the Runner exchanges it.
    const demoted = await joinAs(app, admin.token, ws, 'RunnerDemoted', 'member');
    const code = await issue(demoted);
    await pool.query("update memberships set role = 'guest' where workspace_id = $1 and user_id = $2", [ws, demoted.id]);
    const res = await asRunner(null, 'POST', '/runner/v1/pair', { code: code.code, ...report() });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toContain('Guests cannot pair a Runner');
  });

  it('a non-member of the workspace gets its 404', async () => {
    const stranger = await signUpUser(app, 'RunnerStranger');
    expect((await as(stranger.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).statusCode).toBe(404);
    expect((await as(stranger.token, 'GET', `/workspaces/${ws}/runners`)).statusCode).toBe(404);
  });

  it('a PAT (any scope) cannot pair, activate, change, remove or assign: a person at a keyboard does that', async () => {
    const r = await pair(owner);
    const pat = (await as(owner.token, 'POST', '/me/tokens', { name: 'script', workspace_id: ws, scope: 'write' })).json().token as string;
    const adminPat = (await as(admin.token, 'POST', '/me/tokens', { name: 'admin script', workspace_id: ws, scope: 'admin' })).json().token as string;
    for (const token of [pat, adminPat]) {
      expect((await as(token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).statusCode).toBe(403);
      expect((await as(token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(403);
      expect((await as(token, 'PATCH', `/workspaces/${ws}/runners/${r.id}`, { tool: 'claude-code' })).statusCode).toBe(403);
      expect((await as(token, 'DELETE', `/workspaces/${ws}/runners/${r.id}`)).statusCode).toBe(403);
      expect((await as(token, 'DELETE', `/workspaces/${ws}/runners/pairing-codes/${r.codeId}`)).statusCode).toBe(403);
      expect((await as(token, 'PUT', `/workspaces/${ws}/runner-assignments/${ABSENT}`, { runner_id: null })).statusCode).toBe(403);
    }
    // ... and the pending Runner is still there: nothing above changed it.
    expect((await row(r.id)).status).toBe('pending');
    // A READ token may read its owner's Runners (that is list_runners): the owner's own, nobody else's.
    const readPat = (await as(owner.token, 'POST', '/me/tokens', { name: 'reader', workspace_id: ws, scope: 'read' })).json().token as string;
    const readRes = await as(readPat, 'GET', `/workspaces/${ws}/runners`);
    expect(readRes.statusCode, readRes.body).toBe(200);
    expect(readRes.json().data.some((x: { id: string }) => x.id === r.id)).toBe(true);
    const adminRead = await as(adminPat, 'GET', `/workspaces/${ws}/runners`);
    expect(adminRead.json().data.some((x: { id: string }) => x.id === r.id)).toBe(false);
  });

  it('OWNER-ONLY: another member and an ADMIN each get the exact 404 a nonexistent id gets, on every route that names a Runner', async () => {
    const r = await pairActive(owner);
    const routes: Array<[string, string, unknown?]> = [
      ['POST', `/workspaces/${ws}/runners/ID/activate`, { tool: 'claude-code' }],
      ['PATCH', `/workspaces/${ws}/runners/ID`, { tool: 'claude-code' }],
      ['DELETE', `/workspaces/${ws}/runners/ID`],
    ];
    for (const who of [other, { token: admin.token }]) {
      for (const [method, url, body] of routes) {
        const real = await as(who.token, method, url.replace('ID', r.id), body);
        const absent = await as(who.token, method, url.replace('ID', ABSENT), body);
        expect(shape(real), `${method} ${url}`).toBe(shape(absent));
        expect(real.statusCode).toBe(404);
      }
    }
    // The owner's Runner is untouched by all of that, and the list shows each person only their own.
    expect((await row(r.id)).status).toBe('active');
    const mine = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.map((x: { id: string }) => x.id);
    expect(mine).toContain(r.id);
    for (const who of [other, { token: admin.token }]) {
      expect((await as(who.token, 'GET', `/workspaces/${ws}/runners`)).json().data.map((x: { id: string }) => x.id)).not.toContain(r.id);
    }
  });

  it('someone else\'s pairing code is the same 404 as a nonexistent one, for polling and for Cancel', async () => {
    const code = await issue(owner);
    for (const who of [other, { token: admin.token }]) {
      for (const method of ['GET', 'DELETE']) {
        const real = await as(who.token, method, `/workspaces/${ws}/runners/pairing-codes/${code.id}`);
        const absent = await as(who.token, method, `/workspaces/${ws}/runners/pairing-codes/${ABSENT}`);
        expect(shape(real), method).toBe(shape(absent));
        expect(real.statusCode).toBe(404);
      }
    }
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners/pairing-codes/${code.id}`)).json().status).toBe('waiting');
  });

  it('a Runner token is refused on every route that is not /runner/v1/*, and a PAT, a session or nothing is refused on /runner/v1/*', async () => {
    const r = await pairActive(owner);
    for (const [method, url] of [
      ['GET', `/workspaces/${ws}/runners`],
      ['GET', '/me'],
      ['GET', `/workspaces/${ws}/databases`],
      ['GET', `/workspaces/${ws}/audit-log`],
      ['POST', `/workspaces/${ws}/runners/pairing-codes`],
      ['DELETE', `/workspaces/${ws}/runners/${r.id}`],
    ] as const) {
      const res = await asRunner(r.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.message, `${method} ${url}`).toContain('Runner token works only on the Runner endpoints');
    }
    const pat = (await as(owner.token, 'POST', '/me/tokens', { name: 'p', workspace_id: ws, scope: 'admin' })).json().token as string;
    for (const token of [pat, owner.token, null]) {
      expect((await asRunner(token, 'POST', '/runner/v1/heartbeat', report())).statusCode).toBe(401);
    }
    // The Runner's own credential still works where it should.
    expect((await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report())).statusCode).toBe(200);
  });
});

describe('heartbeat, offline, and the one notification', () => {
  it('a heartbeat records liveness (throttled), the machine name, tools and versions', async () => {
    const r = await pairActive(owner);
    const t0 = new Date('2026-11-01T10:00:00Z');
    const runner = () => runnersSvc.resolveToken(r.token);
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, t0]);

    // Within the write throttle and nothing changed: no write.
    await runnersSvc.heartbeat(await runner(), report(), new Date(t0.getTime() + 5_000));
    expect((await row(r.id)).last_seen_at.toISOString()).toBe(t0.toISOString());
    // Past it: written.
    await runnersSvc.heartbeat(await runner(), report(), new Date(t0.getTime() + 31_000));
    expect((await row(r.id)).last_seen_at.toISOString()).toBe(new Date(t0.getTime() + 31_000).toISOString());
    // A change is written at once, throttle or not.
    await runnersSvc.heartbeat(await runner(), report({ machine_name: 'New name', runner_version: '0.2.0' }), new Date(t0.getTime() + 33_000));
    expect(await row(r.id)).toMatchObject({ name: 'New name', runner_version: '0.2.0' });
    expect((await row(r.id)).last_seen_at.toISOString()).toBe(new Date(t0.getTime() + 33_000).toISOString());
  });

  it('offline_since is DERIVED from last_seen_at: set only while active and silent past the gap, gone the moment it is heard from', async () => {
    const r = await pairActive(owner);
    const find = async () => (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.find((x: { id: string }) => x.id === r.id);
    expect(await find()).toMatchObject({ connection: 'online', offline_since: null });
    const silent = new Date(Date.now() - RUNNER_OFFLINE_AFTER_MS - 60_000);
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, silent]);
    const off = await find();
    expect(off.connection).toBe('offline');
    expect(new Date(off.offline_since).toISOString()).toBe(silent.toISOString());
    // Just inside the gap is NOT offline.
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(Date.now() - RUNNER_OFFLINE_AFTER_MS + 30_000)]);
    expect((await find()).offline_since).toBeNull();
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, silent]);
    await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect(await find()).toMatchObject({ connection: 'online', offline_since: null });
    // There is no stored offline_since column to drift from last_seen_at.
    expect(Object.keys(await row(r.id))).not.toContain('offline_since');
  });

  it('a Runner that goes silent notifies its agents\' owner ONCE per offline episode, not once per sweep', async () => {
    const r = await pairActive(owner);
    const agent = await createAgent(owner, 'Night shift');
    expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
    const count = async () => Number((await pool.query("select coalesce(sum(count),0)::int n from notifications where type = 'runner_offline' and user_id = $1", [owner.id])).rows[0].n);
    const rows = async () => (await pool.query("select count(*)::int n from notifications where type = 'runner_offline' and user_id = $1", [owner.id])).rows[0].n;
    const before = await rows();

    const now = new Date();
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS - 5_000)]);
    const first = await sweeper.sweep(now);
    expect(first.offlineAnnounced).toBe(1);
    for (let i = 1; i <= 5; i++) expect((await sweeper.sweep(new Date(now.getTime() + i * 5_000))).offlineAnnounced).toBe(0);
    expect((await rows()) - before).toBe(1);
    const n = (await pool.query("select * from notifications where type = 'runner_offline' and user_id = $1 order by created_at desc limit 1", [owner.id])).rows[0];
    expect(n.snippet).toContain("Marek's MacBook");
    expect(n.snippet).toContain('Night shift');
    expect(n.record_id).toBeNull();

    // The Runner returns and later goes silent AGAIN: that is a new episode and is announced again.
    await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect((await row(r.id)).offline_notified_at).toBeNull();
    // Age the first notification past the 60 s burst-collapse so the second one is its own row.
    await pool.query("update notifications set created_at = now() - interval '5 minutes' where type = 'runner_offline' and user_id = $1", [owner.id]);
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(Date.now() - RUNNER_OFFLINE_AFTER_MS - 5_000)]);
    expect((await sweeper.sweep(new Date())).offlineAnnounced).toBe(1);
    expect(await count()).toBeGreaterThanOrEqual(2);
  });

  it('two sweeps racing at once announce once (the claim is atomic)', async () => {
    const r = await pairActive(owner);
    const agent = await createAgent(owner, 'Racer');
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id });
    await pool.query("delete from notifications where type = 'runner_offline'");
    const now = new Date();
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS - 5_000)]);
    const results = await Promise.all([sweeper.sweep(now), sweeper.sweep(now), sweeper.sweep(now)]);
    expect(results.reduce((n, x) => n + x.offlineAnnounced, 0)).toBe(1);
    expect(Number((await pool.query("select coalesce(sum(count),0)::int n from notifications where type = 'runner_offline'")).rows[0].n)).toBe(1);
  });

  it('a Runner with no agent on it is not announced (the episode is still marked)', async () => {
    const r = await pairActive(other);
    await pool.query("delete from notifications where type = 'runner_offline'");
    const now = new Date();
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS - 5_000)]);
    await sweeper.sweep(now);
    expect((await pool.query("select count(*)::int n from notifications where type = 'runner_offline' and user_id = $1", [other.id])).rows[0].n).toBe(0);
    expect((await row(r.id)).offline_notified_at).not.toBeNull();
  });

  it('a PENDING Runner is never announced offline (it expires instead)', async () => {
    const r = await pair(owner);
    const now = new Date();
    await pool.query('update runners set last_seen_at = $2 where id = $1', [r.id, new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS - 5_000)]);
    await sweeper.sweep(now);
    expect((await row(r.id)).offline_notified_at).toBeNull();
  });

  it('a Runner below the minimum protocol gets 426 with the one command that fixes it, and the list says "outdated", not "offline"', async () => {
    const r = await pairActive(owner);
    const res = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report({ protocol_version: 0, runner_version: '0.0.1' }));
    expect(res.statusCode, res.body).toBe(426);
    expect(res.json().error.code).toBe('runner_upgrade_required');
    expect(res.json().error.message).toContain('npx @storyos/runner@latest');
    expect(res.json().error.meta).toMatchObject({ minimum_protocol: 1, update_command: 'npx @storyos/runner@latest' });
    const listed = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.find((x: { id: string }) => x.id === r.id);
    expect(listed).toMatchObject({ connection: 'outdated', runner_version: '0.0.1', protocol_version: 0 });
    // Pairing refuses a too-old Runner too, WITHOUT spending the code.
    const code = await issue(owner);
    const old = await asRunner(null, 'POST', '/runner/v1/pair', { code: code.code, ...report({ protocol_version: 0 }) });
    expect(old.statusCode).toBe(426);
    expect((await asRunner(null, 'POST', '/runner/v1/pair', { code: code.code, ...report() })).statusCode).toBe(201);
    // A Runner NEWER than the server speaks is told the server is behind (the sentence names the fix).
    const newer = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report({ protocol_version: 2 }));
    expect(newer.statusCode).toBe(409);
    expect(newer.json().error.code).toBe('server_older_than_runner');
  });
});

describe('removing a Runner, and the agents on it', () => {
  it('Remove revokes the token (refused on the NEXT call), unassigns its agents, and writes the audit trail; a second remove is a 404', async () => {
    const r = await pairActive(owner);
    const agent = await createAgent(owner, 'Doomed run');
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id });
    expect((await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report())).json().assigned_agents.map((a: { id: string }) => a.id)).toEqual([agent]);

    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/${r.id}`)).statusCode).toBe(204);
    const after = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('runner_revoked');
    expect(after.json().error.message).toContain('removed');
    expect(await row(r.id)).toMatchObject({ status: 'revoked', revoked_reason: 'removed' });
    expect((await pool.query('select count(*)::int n from runner_agents where runner_id = $1', [r.id])).rows[0].n).toBe(0);
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.some((x: { id: string }) => x.id === r.id)).toBe(false);
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/${r.id}`)).statusCode).toBe(404);
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runner-assignments/${agent}`)).json().runner).toBeNull();

    // Pair, activate and revoke are in the workspace audit log (admin), with who did it.
    const log = (await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?entity=${r.id}`)).json().data as Array<{ type: string; payload: { object?: { id: string }; reason?: string }; actor_id: string }>;
    const mine = log.filter((e) => e.payload?.object?.id === r.id).map((e) => e.type).sort();
    expect(mine).toEqual(['runner.activated', 'runner.assigned', 'runner.paired', 'runner.revoked'].sort());
    const revoked = log.find((e) => e.type === 'runner.revoked' && e.payload.object?.id === r.id)!;
    expect(revoked.payload.reason).toBe('removed');
    expect(revoked.actor_id).toBe(owner.id);
  });

  // Returning a removed Runner's claimed wakes to the queue (ADR-0021 §3, ticket #1131 AC3's first half) is wired by ticket #1130 and
  // tested with the wake queue in test/agent-wakes.test.ts ('removing a Runner returns the wakes it had claimed').

  it('a Runner whose owner leaves the workspace is refused on its next call and revoked by the sweeper', async () => {
    const leaver = await joinAs(app, admin.token, ws, 'RunnerLeaver', 'member');
    const r = await pairActive(leaver);
    await pool.query('delete from memberships where workspace_id = $1 and user_id = $2', [ws, leaver.id]);
    const res = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report());
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('runner_owner_inactive');
    await sweeper.sweep();
    expect(await row(r.id)).toMatchObject({ status: 'revoked', revoked_reason: 'member_inactive' });
  });

  it('erasing a member from the workspace revokes and anonymises their Runner (the machine name is about a person)', async () => {
    const victim = await joinAs(app, admin.token, ws, 'RunnerVictim', 'member');
    const r = await pairActive(victim);
    const members = (await as(admin.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id: string }>;
    const membershipId = members.find((m) => m.user_id === victim.id)!.id;
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/members/${membershipId}/gdpr/anonymize`)).statusCode).toBe(200);
    const after = await row(r.id);
    expect(after).toMatchObject({ status: 'revoked', name: 'Erased Runner', token_prefix: 'erased', revoked_reason: 'erased' });
    expect(after.user_id).toBe(`erased:${r.id}`);
    expect((await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report())).statusCode).toBe(401);
    expect((await pool.query('select count(*)::int n from runner_pairing_codes where user_id = $1', [victim.id])).rows[0].n).toBe(0);
  });
});

describe('sending an agent to a Runner (ADR-0021 §11 f), and what a Runner is told about', () => {
  it('a Runner only ever hears about the agents assigned to IT', async () => {
    const mine = await pairActive(owner, { machine_name: 'Owner laptop' });
    const mine2 = await pairActive(owner, { machine_name: 'Owner desktop' });
    const theirs = await pairActive(other, { machine_name: 'Other laptop' });
    const a1 = await createAgent(owner, 'Owner agent 1');
    const a2 = await createAgent(owner, 'Owner agent 2');
    const b1 = await createAgent(other, 'Other agent');
    expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${a1}`, { runner_id: mine.id })).json().runner).toMatchObject({ id: mine.id, name: 'Owner laptop' });
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${a2}`, { runner_id: mine2.id });
    await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${b1}`, { runner_id: theirs.id });

    const ids = async (t: string) => (await asRunner(t, 'POST', '/runner/v1/heartbeat', report())).json().assigned_agents.map((a: { id: string }) => a.id);
    expect(await ids(mine.token)).toEqual([a1]);
    expect(await ids(mine2.token)).toEqual([a2]);
    expect(await ids(theirs.token)).toEqual([b1]);
    // Re-assigning moves it: it is one Runner per agent.
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${a1}`, { runner_id: mine2.id });
    expect(await ids(mine.token)).toEqual([]);
    expect((await ids(mine2.token)).sort()).toEqual([a1, a2].sort());
    // The list shows the agents per Runner.
    const listed = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data.find((x: { id: string }) => x.id === mine2.id);
    expect(listed.agents.map((a: { name: string }) => a.name).sort()).toEqual(['Owner agent 1', 'Owner agent 2']);
  });

  it('an agent runs only on its OWNER\'s own active Runner: someone else\'s, a pending one and a missing one are all the same 422', async () => {
    const mine = await pairActive(owner);
    const pending = await pair(owner);
    const theirs = await pairActive(other);
    const agent = await createAgent(owner, 'Picky');
    const bodies: string[] = [];
    for (const runner_id of [theirs.id, pending.id, ABSENT]) {
      const res = await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id });
      expect(res.statusCode, res.body).toBe(422);
      bodies.push(shape(res));
    }
    expect(new Set(bodies).size).toBe(1);
    // An ADMIN may assign the owner's agent, but still only to the OWNER's Runner, never their own or a third party's.
    const adminRunner = await pairActive({ token: admin.token });
    expect((await as(admin.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: adminRunner.id })).statusCode).toBe(422);
    expect((await as(admin.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id })).statusCode).toBe(200);
    expect((await as(admin.token, 'GET', `/workspaces/${ws}/runner-assignments/${agent}`)).json().runner.id).toBe(mine.id);
    // Another member is neither the owner nor an admin: the same 404 an unknown agent gets.
    const real = await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: theirs.id });
    const absent = await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${ABSENT}`, { runner_id: theirs.id });
    expect(shape(real)).toBe(shape(absent));
    expect(real.statusCode).toBe(404);
    expect((await as(other.token, 'GET', `/workspaces/${ws}/runner-assignments/${agent}`)).statusCode).toBe(404);
    // null unassigns.
    expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: null })).json().runner).toBeNull();
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runner-assignments/${agent}`)).json().runner).toBeNull();
  });

  it('only an agent whose AI mode is "Your own AI" can be sent to a Runner', async () => {
    const mine = await pairActive(owner);
    const noMode = await createAgent(owner, 'No mode', null);
    const storyosAi = await createAgent(owner, 'Managed', 'StoryOS AI');
    for (const agent of [noMode, storyosAi]) {
      const res = await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.message).toContain('Your own AI');
    }
  });

  it('guests, PATs and nobody are refused on assignment', async () => {
    const mine = await pairActive(owner);
    const agent = await createAgent(owner, 'Guarded');
    expect((await as(guest.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id })).statusCode).toBe(403);
    expect((await as(null, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id })).statusCode).toBe(401);
    const pat = (await as(owner.token, 'POST', '/me/tokens', { name: 'x', workspace_id: ws, scope: 'admin' })).json().token as string;
    expect((await as(pat, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id })).statusCode).toBe(403);
  });

  it('an agent-scoped token (an agent itself) cannot route its own prompts: it cannot assign or pair', async () => {
    const mine = await pairActive(owner);
    const agent = await createAgent(owner, 'Self-router');
    const agentToken = (await as(owner.token, 'POST', '/me/tokens', { name: 'agent', workspace_id: ws, scope: 'write', agent_id: agent })).json().token as string;
    expect((await as(agentToken, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: mine.id })).statusCode).toBe(403);
    expect((await as(agentToken, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).statusCode).toBe(403);
  });
});

describe('who may hire (premise check, run against the real app)', () => {
  it('records what creating an Agents record does today for each kind of caller', async () => {
    const wsHire = (await as(admin.token, 'POST', '/workspaces', { name: 'Hire WS' })).json().id as string;
    const agentsDb = (await as(admin.token, 'POST', `/workspaces/${wsHire}/agents/ensure`)).json().agentsDb.id as string;
    const m = await joinAs(app, admin.token, wsHire, 'HireMember', 'member');
    const gViewer = await joinAs(app, admin.token, wsHire, 'HireGuestViewer', 'guest', [{ database_id: agentsDb, role: 'viewer' }]);
    const gContrib = await joinAs(app, admin.token, wsHire, 'HireGuestContrib', 'guest', [{ database_id: agentsDb, role: 'contributor' }]);
    const create = async (token: string) => (await as(token, 'POST', `/workspaces/${wsHire}/databases/${agentsDb}/records`, { values: { name: 'Hired', enabled: true } })).statusCode;
    expect(await create(admin.token)).toBe(201);
    expect(await create(m.token)).toBe(201);
    expect(await create(gViewer.token)).toBe(403); // a clean refusal, not a 500
    // NOT enforced by the records route: a guest an admin explicitly granted contributor on the Agents database can create one.
    // The Runner side is what stops such an agent running: a guest cannot pair a Runner, and an agent only runs on its OWNER's own Runner.
    expect(await create(gContrib.token)).toBe(201);
    expect((await as(gContrib.token, 'POST', `/workspaces/${wsHire}/runners/pairing-codes`)).statusCode).toBe(403);
    // Provisioning is admin-only.
    expect((await as(m.token, 'POST', `/workspaces/${wsHire}/agents/ensure`)).statusCode).toBe(403);
  });
});
