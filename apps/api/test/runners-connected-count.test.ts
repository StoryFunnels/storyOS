import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { RunnersService } from '../src/runners/runners.service';
import { RUNNER_OFFLINE_AFTER_MS } from '../src/runners/runner.constants';
import { isConnected } from '../src/runners/runner-present';

/**
 * ticket #1320 (the deferral of ticket #1282 item 4): "N Runners connected" for Settings.
 *
 * `GET /workspaces/{ws}/runners` gains total_count, connected_count, offline_count, at_limit_count and needs_attention, and every
 * row gains `connected`. "Connected" is defined ONCE (runner-present.ts `isConnected`: active, and heard from within
 * RUNNER_OFFLINE_AFTER_MS, the same window `offline_since` and `connection: "offline"` already use), so a row, the count and the
 * existing `connection` cannot disagree. The counts are one aggregate query over the caller's own rows, never a count of a page.
 *
 * Every time-dependent case uses a FIXED `now` handed to the service (no sleeps, no wall clock in an assertion).
 */
let app: NestFastifyApplication;
let svc: RunnersService;
let ws: string;
let otherWs: string;
let admin: { token: string; email: string };
let owner: Person; // a member who holds Runners
let colleague: Person; // another member, with a Runner of their own
let guest: Person;
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = { machine_name: 'Test machine', tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 };

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

/** Pair and press Done: an ACTIVE Runner, last heard from "now" (the wall clock; tests then overwrite last_seen_at). */
async function pairActive(who: { token: string }, workspace = ws): Promise<string> {
  const code = (await as(who.token, 'POST', `/workspaces/${workspace}/runners/pairing-codes`)).json() as { code: string };
  const paired = await app.inject({ method: 'POST', url: '/api/v1/runner/v1/pair', payload: { code: code.code, ...report } as never });
  expect(paired.statusCode, paired.body).toBe(201);
  const id = (paired.json() as { runner: { id: string } }).runner.id;
  const done = await as(who.token, 'POST', `/workspaces/${workspace}/runners/${id}/activate`, { tool: 'claude-code' });
  expect(done.statusCode, done.body).toBe(200);
  return id;
}

/** Pair only: a PENDING Runner (never turned on). */
async function pairPending(who: { token: string }): Promise<string> {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await app.inject({ method: 'POST', url: '/api/v1/runner/v1/pair', payload: { code: code.code, ...report } as never });
  expect(paired.statusCode, paired.body).toBe(201);
  return (paired.json() as { runner: { id: string } }).runner.id;
}

const NOW = new Date('2026-11-18T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const setSeen = (id: string, at: Date | null) => pool.query('update runners set last_seen_at = $2 where id = $1', [id, at]);

const listAt = (userId: string, now = NOW) => svc.list(ws, userId, now);

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(RunnersService);
  admin = await signUpUser(app, 'ConnAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Connected WS' })).json().id;
  otherWs = (await as(admin.token, 'POST', '/workspaces', { name: 'Elsewhere WS' })).json().id;
  owner = await joinAs(app, admin.token, ws, 'ConnOwner', 'member');
  colleague = await joinAs(app, admin.token, ws, 'ConnColleague', 'member');
  const agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id as string;
  guest = await joinAs(app, admin.token, ws, 'ConnGuest', 'guest', [{ database_id: agentsDbId, role: 'viewer' }]);
}, 120_000);

beforeEach(async () => {
  await pool.query('delete from runner_pairing_failures');
  await pool.query("update runner_pairing_codes set created_at = created_at - interval '3 hours'");
  await pool.query('delete from runners where workspace_id in ($1, $2)', [ws, otherWs]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the counts: 0, 1 and N Runners', () => {
  it('a person with no Runner gets zeros and no warning (a zero is a real answer, not a missing one)', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${ws}/runners`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ data: [], total_count: 0, connected_count: 0, offline_count: 0, at_limit_count: 0, needs_attention: false });
  });

  it('one fresh active Runner: 1 of 1 connected, no warning, and the row says connected: true', async () => {
    const id = await pairActive(owner);
    await setSeen(id, ago(5_000));
    const out = await listAt(owner.id);
    expect(out).toMatchObject({ total_count: 1, connected_count: 1, offline_count: 0, at_limit_count: 0, needs_attention: false });
    expect(out.data[0]).toMatchObject({ id, status: 'active', connection: 'online', connected: true });
  });

  it('N Runners: connected, stale, pending (counted in the total, never connected). A removed Runner is in none of them', async () => {
    const a = await pairActive(owner);
    const b = await pairActive(owner);
    const c = await pairActive(owner);
    const stale = await pairActive(owner);
    const pending = await pairPending(owner);
    const removed = await pairActive(owner);
    await setSeen(a, ago(1_000));
    await setSeen(b, ago(60_000));
    await setSeen(c, ago(RUNNER_OFFLINE_AFTER_MS - 1));
    await setSeen(stale, ago(RUNNER_OFFLINE_AFTER_MS + 60_000));
    await pool.query("update runners set status = 'revoked', revoked_at = $2, revoked_reason = 'removed', last_seen_at = $2 where id = $1", [removed, NOW]);
    const out = await listAt(owner.id);
    expect(out.total_count).toBe(5);
    expect(out.connected_count).toBe(3);
    expect(out.offline_count).toBe(1);
    expect(out.needs_attention).toBe(true); // one active Runner is offline
    const byId = new Map(out.data.map((r) => [r.id, r]));
    expect(byId.get(stale)).toMatchObject({ connection: 'offline', connected: false });
    expect(byId.get(pending)).toMatchObject({ status: 'pending', connected: false });
    expect(byId.has(removed)).toBe(false);
  });

  it('a pending Runner is not offline either: it is in the total only (it expires instead)', async () => {
    await pairPending(owner);
    const out = await listAt(owner.id, new Date(NOW.getTime() + 10 * 365 * 86_400_000)); // even far in the future, the "silence" of a pending Runner is not offline
    expect(out).toMatchObject({ total_count: 1, connected_count: 0, offline_count: 0, needs_attention: false });
  });
});

describe('the window edge (a fixed clock, no sleeping)', () => {
  it('heard exactly RUNNER_OFFLINE_AFTER_MS ago is still connected; one millisecond later it is offline (the same edge as offline_since)', async () => {
    const id = await pairActive(owner);
    await setSeen(id, ago(RUNNER_OFFLINE_AFTER_MS));
    const edge = await listAt(owner.id);
    expect(edge.data[0]).toMatchObject({ connected: true, connection: 'online', offline_since: null });
    expect(edge).toMatchObject({ connected_count: 1, offline_count: 0 });

    await setSeen(id, ago(RUNNER_OFFLINE_AFTER_MS + 1));
    const past = await listAt(owner.id);
    expect(past.data[0]).toMatchObject({ connected: false, connection: 'offline' });
    expect(past.data[0].offline_since).not.toBeNull();
    expect(past).toMatchObject({ connected_count: 0, offline_count: 1, needs_attention: true });
  });

  it('a Runner never heard from after pairing is judged from when it was turned on', async () => {
    const id = await pairActive(owner);
    await setSeen(id, null);
    // created long ago, so only `activated_at` can make it connected (the count and the row must both look at it).
    await pool.query('update runners set created_at = $2 where id = $1', [id, ago(10 * 86_400_000)]);
    await pool.query('update runners set activated_at = $2 where id = $1', [id, ago(30_000)]);
    const fresh = await listAt(owner.id);
    expect(fresh.data[0]).toMatchObject({ connected: true });
    expect(fresh).toMatchObject({ connected_count: 1, offline_count: 0 });
    await pool.query('update runners set activated_at = $2 where id = $1', [id, ago(RUNNER_OFFLINE_AFTER_MS + 1)]);
    const old = await listAt(owner.id);
    expect(old.data[0]).toMatchObject({ connected: false, connection: 'offline' });
    expect(old).toMatchObject({ connected_count: 0, offline_count: 1 });
    // and with neither of the two set, it is judged from when it was paired
    await pool.query('update runners set activated_at = null, created_at = $2 where id = $1', [id, ago(30_000)]);
    expect(await listAt(owner.id)).toMatchObject({ connected_count: 1 });
  });

  it('the same instant, read later, flips: the answer is a function of `now`, not of when the row was written', async () => {
    const id = await pairActive(owner);
    await setSeen(id, NOW);
    expect((await listAt(owner.id, NOW)).connected_count).toBe(1);
    expect((await listAt(owner.id, new Date(NOW.getTime() + RUNNER_OFFLINE_AFTER_MS))).connected_count).toBe(1);
    expect((await listAt(owner.id, new Date(NOW.getTime() + RUNNER_OFFLINE_AFTER_MS + 1))).connected_count).toBe(0);
  });
});

describe('at its limit', () => {
  it('a Runner whose tool hit its limit is still connected (it is heartbeating), counted in at_limit_count, and raises the warning', async () => {
    const id = await pairActive(owner);
    await setSeen(id, ago(1_000));
    await pool.query("update runners set paused_until = $2, pause_reason = 'limit_reached' where id = $1", [id, new Date(NOW.getTime() + 3_600_000)]);
    const out = await listAt(owner.id);
    expect(out).toMatchObject({ total_count: 1, connected_count: 1, offline_count: 0, at_limit_count: 1, needs_attention: true });
    expect(out.data[0]).toMatchObject({ connected: true, connection: 'paused' });
  });

  it('a limit that has already passed counts for nothing; one that passes exactly now is over', async () => {
    const id = await pairActive(owner);
    await setSeen(id, ago(1_000));
    await pool.query('update runners set paused_until = $2 where id = $1', [id, NOW]);
    expect(await listAt(owner.id)).toMatchObject({ at_limit_count: 0, needs_attention: false });
    await pool.query('update runners set paused_until = $2 where id = $1', [id, new Date(NOW.getTime() + 1)]);
    expect(await listAt(owner.id)).toMatchObject({ at_limit_count: 1, needs_attention: true });
  });

  it('only an ACTIVE Runner can be at its limit (a stale paused_until on a pending one is ignored)', async () => {
    const id = await pairPending(owner);
    await pool.query('update runners set paused_until = $2 where id = $1', [id, new Date(NOW.getTime() + 3_600_000)]);
    expect(await listAt(owner.id)).toMatchObject({ total_count: 1, at_limit_count: 0, needs_attention: false });
  });
});

describe('rows and counts agree (they share one definition)', () => {
  it('over a mix of ages, the counts equal what the rows say, and every row equals the shared isConnected()', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await pairActive(owner));
    ids.push(await pairPending(owner));
    const ages = [0, 1_000, RUNNER_OFFLINE_AFTER_MS - 1, RUNNER_OFFLINE_AFTER_MS, RUNNER_OFFLINE_AFTER_MS + 1, 3_600_000];
    for (let i = 0; i < ages.length; i++) await setSeen(ids[i], ago(ages[i]));
    await pool.query('update runners set paused_until = $2 where id = $1', [ids[1], new Date(NOW.getTime() + 60_000)]);
    await pool.query('update runners set paused_until = $2 where id = $1', [ids[5], new Date(NOW.getTime() + 60_000)]); // stale AND at its limit

    const out = await listAt(owner.id);
    const rowConnected = out.data.filter((r) => r.connected).length;
    const rowOffline = out.data.filter((r) => r.status === 'active' && !r.connected).length;
    const rowAtLimit = out.data.filter((r) => r.status === 'active' && r.paused_until && new Date(r.paused_until as never) > NOW).length;
    expect(out.total_count).toBe(out.data.length);
    expect(out.connected_count).toBe(rowConnected);
    expect(out.offline_count).toBe(rowOffline);
    expect(out.at_limit_count).toBe(rowAtLimit);
    expect([out.connected_count, out.offline_count, out.at_limit_count]).toEqual([4, 2, 2]);

    // The row flag is the helper's answer for the raw database row, and `connected` is never contradicted by `connection`.
    const raw = (await pool.query('select * from runners where user_id = $1', [owner.id])).rows;
    for (const r of out.data) {
      const db = raw.find((x: { id: string }) => x.id === r.id);
      const shaped = { status: db.status, lastSeenAt: db.last_seen_at, activatedAt: db.activated_at, createdAt: db.created_at };
      expect(r.connected, `${r.id}`).toBe(isConnected(shaped as never, NOW));
      if (r.connection === 'offline') expect(r.connected).toBe(false);
      if (r.status === 'active' && r.connection === 'online') expect(r.connected).toBe(true); // a PENDING row also reads `online` today; it is never connected
    }
  });

  it('the same numbers come over HTTP (the real route, the real clock)', async () => {
    const a = await pairActive(owner);
    const b = await pairActive(owner);
    await pool.query('update runners set last_seen_at = now() - interval \'1 hour\' where id = $1', [b]);
    await pool.query('update runners set last_seen_at = now() where id = $1', [a]);
    const res = await as(owner.token, 'GET', `/workspaces/${ws}/runners`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total_count: 2, connected_count: 1, offline_count: 1, at_limit_count: 0, needs_attention: true });
    expect(body.data.map((r: { connected: boolean }) => r.connected).sort()).toEqual([false, true]);
  });
});

describe('who sees what (a count must not leak a Runner the list would not show)', () => {
  it("a colleague's Runners are in neither the rows nor the counts, and an ADMIN gets their own only", async () => {
    const mine = await pairActive(owner);
    await pairActive(colleague);
    await pairActive(colleague);
    await pairActive(admin as never);
    await setSeen(mine, ago(1_000));
    const own = await listAt(owner.id);
    expect(own).toMatchObject({ total_count: 1, connected_count: 1 });
    expect(own.data.map((r) => r.id)).toEqual([mine]);
    const theirs = await as(colleague.token, 'GET', `/workspaces/${ws}/runners`);
    expect(theirs.json()).toMatchObject({ total_count: 2 });
    const adminView = await as(admin.token, 'GET', `/workspaces/${ws}/runners`);
    expect(adminView.json()).toMatchObject({ total_count: 1 }); // the admin's own, not the workspace's three
  });

  it('a Runner in ANOTHER workspace is not counted here', async () => {
    const elsewhere = await joinAs(app, admin.token, otherWs, 'ConnTraveller', 'member');
    await pairActive(elsewhere, otherWs);
    const both = await joinAs(app, admin.token, otherWs, 'ConnBoth', 'member');
    await pairActive(both, otherWs);
    // The SAME person holding a Runner in the other workspace: it is theirs, but it is not counted here.
    const mineElsewhere = await pairActive(owner);
    await pool.query('update runners set workspace_id = $2 where id = $1', [mineElsewhere, otherWs]);
    // In ws they now own none.
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json()).toMatchObject({ total_count: 0, connected_count: 0 });
    // And the other workspace is a 404 for someone who is not in it: no count, not even a zero.
    const refused = await as(owner.token, 'GET', `/workspaces/${otherWs}/runners`);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).not.toHaveProperty('total_count');
  });

  it('a guest gets the same 403 as before, with no count in the body; nobody signed in is 401; a stranger is 404', async () => {
    const g = await as(guest.token, 'GET', `/workspaces/${ws}/runners`);
    expect(g.statusCode, g.body).toBe(403);
    expect(g.json().error.message).toBe('Requires member role'); // exactly what the list said before this change
    expect(g.json()).not.toHaveProperty('total_count');
    expect((await as(null, 'GET', `/workspaces/${ws}/runners`)).statusCode).toBe(401);
    const stranger = await signUpUser(app, 'ConnStranger');
    expect((await as(stranger.token, 'GET', `/workspaces/${ws}/runners`)).statusCode).toBe(404);
  });
});

describe('what must be KEPT: every field the list already returned is still there, unchanged', () => {
  it('a row has exactly the previous keys plus `connected`; the envelope keeps `data`', async () => {
    const id = await pairActive(owner);
    const res = await as(owner.token, 'GET', `/workspaces/${ws}/runners`);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['at_limit_count', 'connected_count', 'data', 'needs_attention', 'offline_count', 'total_count']);
    const row = body.data.find((r: { id: string }) => r.id === id);
    expect(Object.keys(row).sort()).toEqual(
      [
        'agents', 'chosen_tool', 'connected', 'connection', 'hold', 'id', 'last_seen_at', 'name', 'offline_since', 'paired_at', 'pause_reason',
        'paused_until', 'pending_expires_at', 'protocol_version', 'reserve_measurable', 'reserve_percent', 'reserve_unmeasurable_message',
        'runner_version', 'status', 'tools', 'working_hours', 'working_hours_closes_at', 'working_hours_resumes_at', 'within_working_hours',
      ].sort(),
    );
    // The values the page already reads are untouched.
    expect(row).toMatchObject({ status: 'active', connection: 'online', chosen_tool: 'claude-code', runner_version: '0.1.0', protocol_version: 1, offline_since: null, agents: [] });
  });

  it('no secret and no host identifier was added: nothing about a token, its hash or a network address', async () => {
    await pairActive(owner);
    const text = (await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).body;
    expect(text).not.toMatch(/token|hash|mn_run_|ip_address|127\.0\.0\.1/i);
  });
});
