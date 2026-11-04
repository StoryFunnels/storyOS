import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentWakesService } from '../src/runners/agent-wakes.service';
import { runners } from '../src/db/schema';
import type { Db } from '../src/db/client';

/**
 * ticket #1137 — sharing the subscription: working hours, "leave me X%", pause on limit and resume at the reset. Real fixtures: the
 * Runner's owner (a member), another member, an admin, a guest, a PAT and a Runner token. The claim is driven with a controlled clock
 * (`claim(runner, { now })`) where time matters, and over HTTP with the real clock where the shape on the wire matters.
 */
let app: NestFastifyApplication;
let wakes: AgentWakesService;
let db: Db;
let ws: string;
let agentsDbId: string;
let admin: { token: string; email: string };
let owner: Person;
let other: Person;
let guest: Person;
let aiModeIds: Record<string, string> = {};
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = (tools: unknown[] = TOOLS) => ({ machine_name: "Owner's MacBook", tools, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const claim = (token: string) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
const ABSENT = '00000000-0000-4000-8000-000000000000';
const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

async function mkAgent(who: { token: string }, name: string): Promise<string> {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true, ai_mode: aiModeIds['Your own AI'] } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function pairRunner(who: Person, agentIds: string[] = [], tools: unknown[] = TOOLS) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report(tools) });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner } = paired.json() as { token: string; runner: { id: string } };
  const done = await as(who.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' });
  expect(done.statusCode, done.body).toBe(200);
  for (const agent of agentIds) {
    const res = await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id });
    expect(res.statusCode, res.body).toBe(200);
  }
  return { token, id: runner.id };
}

const runnerRow = async (id: string) => (await db.query.runners.findFirst({ where: eq(runners.id, id) }))!;
const patch = (who: { token: string }, id: string, body: unknown) => as(who.token, 'PATCH', `/workspaces/${ws}/runners/${id}`, body);
const listed = async (id: string) => ((await as(owner.token, 'GET', `/workspaces/${ws}/runners`)).json().data as Array<Record<string, any>>).find((r) => r.id === id)!;

async function freshWake(agent: string) {
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1 and status in ('queued','claimed')", [agent]);
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`);
  expect(res.statusCode, res.body).toBe(201);
  return (await pool.query("select id, run_id from agent_wakes where agent_id = $1 and status = 'queued'", [agent])).rows[0] as { id: string; run_id: string };
}

/** An hour-aligned UTC window around the real now: `inside` true = now is in the middle of it, false = it opens in 2 hours. */
function utcWindow(inside: boolean) {
  const h = new Date().getUTCHours();
  const hh = (n: number) => `${String(((n % 24) + 24) % 24).padStart(2, '0')}:00`;
  return inside ? { days: ALL, start: hh(h - 1), end: hh(h + 2), timezone: 'UTC' } : { days: ALL, start: hh(h + 2), end: hh(h + 4), timezone: 'UTC' };
}

beforeAll(async () => {
  app = await createTestApp();
  wakes = app.get(AgentWakesService);
  db = (wakes as unknown as { db: Db }).db;
  admin = await signUpUser(app, 'LimitsAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Limits WS' })).json().id;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  owner = await joinAs(app, admin.token, ws, 'LimitsOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'LimitsOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'LimitsGuest', 'guest', [{ database_id: agentsDbId, role: 'viewer' }]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('who may change sharing settings (the Runner rules: owner only, admins included)', () => {
  it('the owner sets, reads and clears them; another member and an ADMIN get the same 404 as a nonexistent id; a guest, a PAT and a Runner token cannot', async () => {
    const r = await pairRunner(owner);
    const hours = { days: ['mon', 'tue'], start: '22:00', end: '06:00', timezone: 'Europe/Kyiv' };
    const set = await patch(owner, r.id, { working_hours: hours, reserve_percent: 25 });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ working_hours: hours, reserve_percent: 25 });
    expect((await listed(r.id)).working_hours).toEqual(hours);

    const shape = (res: { statusCode: number; body: string }) => `${res.statusCode} ${res.body.replace(/"request_id":"[^"]*"/, '')}`;
    for (const who of [other, { token: admin.token }]) {
      const real = await patch(who, r.id, { reserve_percent: 50 });
      const absent = await patch(who, ABSENT, { reserve_percent: 50 });
      expect(real.statusCode).toBe(404);
      expect(shape(real)).toBe(shape(absent));
    }
    expect((await patch(guest, r.id, { reserve_percent: 50 })).statusCode).toBe(403);
    const pat = (await as(owner.token, 'POST', '/me/tokens', { name: 'script', workspace_id: ws, scope: 'write' })).json().token as string;
    expect((await patch({ token: pat }, r.id, { reserve_percent: 50 })).statusCode).toBe(403);
    expect([401, 403]).toContain((await patch({ token: r.token }, r.id, { reserve_percent: 50 })).statusCode); // the Runner's own credential is not a person
    expect((await runnerRow(r.id)).sharing).toMatchObject({ reserve_percent: 25 }); // none of the above changed it

    // Setting only the tool keeps the rules; null clears just that rule.
    expect((await patch(owner, r.id, { tool: 'claude-code' })).json()).toMatchObject({ working_hours: hours, reserve_percent: 25 });
    const cleared = await patch(owner, r.id, { reserve_percent: null });
    expect(cleared.json()).toMatchObject({ working_hours: hours, reserve_percent: null });
    expect((await patch(owner, r.id, { working_hours: null })).json()).toMatchObject({ working_hours: null, within_working_hours: null, hold: null });
  });

  it('refuses nonsense with 422 and changes nothing: an empty body, an unknown zone, start = end, a reserve outside 1..95', async () => {
    const r = await pairRunner(owner);
    for (const body of [
      {},
      { working_hours: { days: ['mon'], start: '22:00', end: '06:00', timezone: 'Mars/Olympus' } },
      { working_hours: { days: ['mon'], start: '22:00', end: '22:00', timezone: 'UTC' } },
      { working_hours: { days: [], start: '22:00', end: '06:00', timezone: 'UTC' } },
      { reserve_percent: 0 },
      { reserve_percent: 96 },
    ]) {
      const res = await patch(owner, r.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await runnerRow(r.id)).sharing).toEqual({});
  });
});

describe('working hours: the claim, with a controlled clock', () => {
  it('outside the window nothing is claimed and the hold says when it opens; inside it the queued wake IS claimed (overnight window, winter and summer)', async () => {
    const agent = await mkAgent(owner, 'Night bot');
    const r = await pairRunner(owner, [agent]);
    await patch(owner, r.id, { working_hours: { days: ALL, start: '22:00', end: '06:00', timezone: 'Europe/Kyiv' } });
    const w = await freshWake(agent);
    const row = await runnerRow(r.id);

    // Winter: Kyiv is UTC+2. 12:00Z is 14:00 local: closed, opens 20:00Z.
    const noon = new Date('2027-01-13T12:00:00Z');
    expect(await wakes.claim(row, { waitSeconds: 0, now: noon })).toEqual([]);
    expect(wakes.claimHold(row, noon)).toEqual({ reason: 'working_hours', resumes_at: new Date('2027-01-13T20:00:00Z') });
    // The wake waited: still queued, untouched.
    expect((await pool.query('select status from agent_wakes where id = $1', [w.id])).rows[0].status).toBe('queued');
    // Summer: UTC+3, the same wall clock opens an hour earlier in UTC.
    expect(wakes.claimHold(row, new Date('2027-07-13T12:00:00Z'))?.resumes_at).toEqual(new Date('2027-07-13T19:00:00Z'));
    // One second before it opens: still nothing. Then it opens and the SAME queued wake is handed out.
    expect(await wakes.claim(row, { waitSeconds: 0, now: new Date('2027-01-13T19:59:59Z') })).toEqual([]);
    const got = await wakes.claim(row, { waitSeconds: 0, now: new Date('2027-01-13T20:00:00Z') });
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(w.id);
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where id = $1", [w.id]);
  });

  it('over HTTP with the real clock: outside answers 204 with the hold headers and the Runner list says why; inside it answers 200 with the wake', async () => {
    const agent = await mkAgent(owner, 'Http hours bot');
    const r = await pairRunner(owner, [agent]);
    const w = await freshWake(agent);

    const closed = await patch(owner, r.id, { working_hours: utcWindow(false) });
    expect(closed.json()).toMatchObject({ within_working_hours: false, hold: { reason: 'working_hours' } });
    const none = await claim(r.token);
    expect(none.statusCode).toBe(204);
    expect(none.headers['x-runner-hold-reason']).toBe('working_hours');
    const resumes = new Date(String(none.headers['x-runner-resumes-at']));
    expect(resumes.getTime()).toBeGreaterThan(Date.now());
    expect(resumes.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 60_000);
    expect((await listed(r.id)).hold.resumes_at).toBe(resumes.toISOString());

    // The wake's run state names the window, from the server (the client never works it out).
    const state = ((await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json().data as Array<any>).find((x) => x.id === w.id).run_state;
    expect(state).toMatchObject({ state: 'waiting_for_hours', runner_name: "Owner's MacBook" });
    expect(new Date(state.until).toISOString()).toBe(resumes.toISOString());

    await patch(owner, r.id, { working_hours: utcWindow(true) });
    expect((await listed(r.id)).within_working_hours).toBe(true);
    const open = await claim(r.token);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().wakes[0].id).toBe(w.id);
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where id = $1", [w.id]);
  });
});

describe('pause on limit, resume at the reset', () => {
  it('a simulated limit stop pauses ALL claims of that Runner until the reset and resumes by itself after it; a second Runner of the same person is unaffected', async () => {
    const a1 = await mkAgent(owner, 'Limit bot A');
    const a2 = await mkAgent(owner, 'Limit bot B');
    const a3 = await mkAgent(owner, 'Other Runner bot');
    const r = await pairRunner(owner, [a1, a2]);
    const sibling = await pairRunner(owner, [a3]);
    const w1 = await freshWake(a1);
    const first = (await claim(r.token)).json().wakes[0];
    expect(first.id).toBe(w1.id);

    const until = new Date(Date.now() + 3 * 3_600_000);
    const done = await asRunner(r.token, 'POST', `/runner/v1/wakes/${w1.id}/complete`, { nonce: first.nonce, exit: 'limit_reached', limit_reached_until: until.toISOString() });
    expect(done.json()).toMatchObject({ status: 'queued', requeued: true });

    // A wake for the OTHER agent on the SAME Runner is also held: the pause is the Runner's, not the wake's.
    const w2 = await freshWake(a2);
    const paused = await claim(r.token);
    expect(paused.statusCode).toBe(204);
    expect(paused.headers['x-runner-hold-reason']).toBe('limit_reached');
    expect(new Date(String(paused.headers['x-runner-resumes-at'])).toISOString()).toBe(until.toISOString());
    expect(await listed(r.id)).toMatchObject({ paused_until: until.toISOString(), connection: 'paused', hold: { reason: 'limit_reached', resumes_at: until.toISOString() } });

    // The person's OTHER Runner keeps working.
    const w3 = await freshWake(a3);
    expect((await claim(sibling.token)).json().wakes[0].id).toBe(w3.id);

    // Controlled clock: one second before the reset nothing; at the reset the Runner claims again with no one touching it.
    const row = await runnerRow(r.id);
    expect(await wakes.claim(row, { waitSeconds: 0, now: new Date(until.getTime() - 1000) })).toEqual([]);
    const after = await wakes.claim(row, { max: 2, waitSeconds: 0, now: new Date(until.getTime() + 1000) });
    expect(after.map((x) => x.id).sort()).toEqual([w1.id, w2.id].sort()); // the requeued wake AND the one that waited behind the pause
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where id in ($1, $2, $3)", [w1.id, w2.id, w3.id]);
  });
});

describe('"leave me X%": stored always, kept only where the tool reports it', () => {
  it('claude-code reports no plan usage: reserve_measurable is false (with the sentence), the setting is stored, and it never blocks a claim on a made-up number', async () => {
    const agent = await mkAgent(owner, 'Reserve bot');
    const r = await pairRunner(owner, [agent]);
    const set = await patch(owner, r.id, { reserve_percent: 40 });
    expect(set.json()).toMatchObject({ reserve_percent: 40, reserve_measurable: false });
    expect(set.json().reserve_unmeasurable_message).toMatch(/does not report/);
    expect(set.json().tools[0]).toMatchObject({ id: 'claude-code', reserve_measurable: false });
    const w = await freshWake(agent);
    expect((await claim(r.token)).json().wakes[0].id).toBe(w.id);
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where id = $1", [w.id]);
  });

  it('a tool that DOES report plan usage: past the reserve the Runner stops claiming (reserve hold, reset time when reported); under it, it claims', async () => {
    const meter = (used: number, resets?: string) => [{ id: 'claude-code', installed: true, capabilities: { plan_usage_percent: used, ...(resets ? { plan_usage_resets_at: resets } : {}) } }];
    const agent = await mkAgent(owner, 'Metered bot');
    const r = await pairRunner(owner, [agent], meter(50));
    const set = await patch(owner, r.id, { reserve_percent: 30 });
    expect(set.json()).toMatchObject({ reserve_measurable: true, reserve_unmeasurable_message: null });
    const w = await freshWake(agent);

    const reset = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const hb = await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report(meter(80, reset)));
    expect(hb.statusCode, hb.body).toBe(200);
    const held = await claim(r.token);
    expect(held.statusCode).toBe(204);
    expect(held.headers['x-runner-hold-reason']).toBe('reserve');
    expect(held.headers['x-runner-resumes-at']).toBe(reset);
    const state = ((await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json().data as Array<any>).find((x) => x.id === w.id).run_state;
    expect(state).toMatchObject({ state: 'waiting_for_reserve', until: reset });

    await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report(meter(60)));
    expect((await claim(r.token)).json().wakes[0].id).toBe(w.id);
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where id = $1", [w.id]);
  });
});

describe('an OPEN long poll honours a rule that changes while it waits (a wake arriving mid-poll was claimed after hours closed)', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const poll = (token: string) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 6 });
  const count = async (agent: string, status: string) => (await pool.query('select count(*)::int as n from agent_wakes where agent_id = $1 and status = $2', [agent, status])).rows[0].n as number;
  const settle = (agent: string) => pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1", [agent]);

  it('hours that close while the poll is open: the wake that arrives afterwards is NOT claimed (204, working_hours hold) and stays queued; once they reopen it is claimed', async () => {
    const agent = await mkAgent(owner, 'Mid-poll hours bot');
    const r = await pairRunner(owner, [agent]);
    await patch(owner, r.id, { working_hours: utcWindow(true) });
    const open = poll(r.token); // nothing is queued, so it waits
    await pause(300);
    await patch(owner, r.id, { working_hours: utcWindow(false) });
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).statusCode).toBe(201);
    const res = await open;
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers['x-runner-hold-reason']).toBe('working_hours');
    expect(await count(agent, 'queued')).toBe(1);
    expect(await count(agent, 'claimed')).toBe(0);
    await patch(owner, r.id, { working_hours: utcWindow(true) });
    expect((await claim(r.token)).statusCode).toBe(200);
    await settle(agent);
  });

  it('a reserve that is passed while the poll is open (the tool reports more usage on its heartbeat): the wake is NOT claimed', async () => {
    const meter = (used: number) => [{ id: 'claude-code', installed: true, capabilities: { plan_usage_percent: used } }];
    const agent = await mkAgent(owner, 'Mid-poll reserve bot');
    const r = await pairRunner(owner, [agent], meter(40));
    await patch(owner, r.id, { reserve_percent: 30 });
    const open = poll(r.token);
    await pause(300);
    expect((await asRunner(r.token, 'POST', '/runner/v1/heartbeat', report(meter(85)))).statusCode).toBe(200);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).statusCode).toBe(201);
    const res = await open;
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers['x-runner-hold-reason']).toBe('reserve');
    expect(await count(agent, 'queued')).toBe(1);
    await settle(agent);
  });

  it('control: with no rule change the same poll DOES claim a wake that arrives mid-poll', async () => {
    const agent = await mkAgent(owner, 'Mid-poll control bot');
    const r = await pairRunner(owner, [agent]);
    await patch(owner, r.id, { working_hours: utcWindow(true) });
    const open = poll(r.token);
    await pause(300);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).statusCode).toBe(201);
    const res = await open;
    expect(res.statusCode, res.body).toBe(200);
    await settle(agent);
  });
});
