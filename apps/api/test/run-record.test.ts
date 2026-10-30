import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { WAKE_LIMIT_FALLBACK_MS, WAKE_LIMIT_MAX_MS } from '../src/runners/wake.constants';
import { resolveLimitUntil, capSummary, addUsage } from '../src/runners/run-record';

/**
 * #1133 / ADR-0021 §2, §5, §6 — the run record, the limit-reached requeue and the must-comment backstop. Real fixtures: a MEMBER who
 * owns the agents and a Runner, an ADMIN, ANOTHER member, a GUEST-owned agent, and a second Runner of someone else. Every claim is the
 * real thing: a Runner pairs, claims over HTTP, comments with the credential the claim handed it (so the comment carries the run id
 * the backstop looks for), and completes over HTTP; the Run and the audit rows are read back.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let admin: { token: string; email: string };
let owner: Person; // a MEMBER: owns the agents and a Runner
let other: Person; // another member, with a Runner of their own
let guest: Person;
let runner: { token: string; id: string };
let otherRunner: { token: string; id: string };
let aiOwn = '';
let scopeIds: Record<string, string> = {};
let runStatusIds: Record<string, string> = {};
let exitIds: Record<string, string> = {};
const { pool } = connectTestDb();
vi.setConfig({ testTimeout: 120_000 }); // the suite makes dozens of real HTTP round trips; a loaded CI box is slow

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const MACHINE = "Ievgen's MacBook";
const report = (machine = MACHINE) => ({ machine_name: machine, tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const claim = (token: string, body: Record<string, unknown> = {}) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0, ...body });
const txt = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] });

type Claimed = { id: string; nonce: string; run_id: string | null; credential: { token: string; scope: string } };
type Ticket = { id: string };

async function mkAgent(who: { token: string }, name: string): Promise<string> {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds.write] } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mkTicket(name: string): Promise<Ticket> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id as string };
}
async function pairRunner(who: Person, machine: string, agentIds: string[]) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report(machine) });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(who.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  for (const agent of agentIds) expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
  return { token, id: r.id };
}

let agent: string;
/** A fresh ticket, delegated to the agent, claimed by `runner`: the wake and the credential the claim handed over. */
async function startRun(forAgent = agent, token = runner.token): Promise<Claimed & { ticket: string; agent: string }> {
  const ticket = await mkTicket(`T ${Math.random().toString(36).slice(2, 8)}`);
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${forAgent}/delegate`, { record_id: ticket.id });
  expect(res.statusCode, res.body).toBe(201);
  const got = await claim(token);
  expect(got.statusCode, got.body).toBe(200);
  return { ...((got.json() as { wakes: Claimed[] }).wakes[0] as Claimed), ticket: ticket.id, agent: forAgent };
}
/** The agent's own comment on its record, with the run credential: it carries the run id the backstop reads. */
const agentComments = (w: Claimed & { ticket: string }, text = 'Done: I did the thing.') =>
  as(w.credential.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}/comments`, { body: { format: 'blocknote', doc: [txt(text)] } });
const finish = (w: Claimed, body: Record<string, unknown> = {}, token = runner.token) =>
  asRunner(token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: w.nonce, exit: 'ok', ...body });
const runRecord = async (runId: string) => (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${runId}`)).json() as { values: Record<string, unknown> };
const labelOf = (ids: Record<string, string>, id: unknown) => Object.entries(ids).find(([, v]) => v === id)?.[0];
const runStatus = async (runId: string) => labelOf(runStatusIds, (await runRecord(runId)).values.status);
const stepsText = async (runId: string) => JSON.stringify((await runRecord(runId)).values.steps ?? '');
const wakeRow = async (id: string) => (await pool.query('select * from agent_wakes where id = $1', [id])).rows[0];
const failedNotes = async (userId: string, recordId: string) =>
  (await pool.query("select coalesce(sum(count),0)::int n from notifications where type = 'agent_wake_failed' and user_id = $1 and record_id = $2", [userId, recordId])).rows[0].n as number;
let ownerId = '';
let otherId = '';

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RunRecAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Run record WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');
  runStatusIds = await opt(runsDbId, 'status');
  exitIds = await opt(runsDbId, 'exit');
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  owner = await joinAs(app, admin.token, ws, 'RunRecOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'RunRecOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'RunRecGuest', 'guest', [{ database_id: ticketsDbId, role: 'contributor' }]);
  ownerId = (await as(owner.token, 'GET', '/me')).json().id;
  otherId = (await as(other.token, 'GET', '/me')).json().id;
  agent = await mkAgent(owner, 'Recorder');
  runner = await pairRunner(owner, MACHINE, [agent]);
  otherRunner = await pairRunner(other, "Other's laptop", []);
}, 400_000);

beforeEach(async () => {
  await pool.query('delete from runner_pairing_failures');
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
  await pool.query('update runners set paused_until = null, pause_reason = null where workspace_id = $1', [ws]);
  await pool.query('update api_tokens set revoked_at = now() where workspace_id = $1 and runner_id is not null and revoked_at is null', [ws]);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('AC1: every run leaves a run record with the fields', () => {
  it('a completed run carries agent, record, wake reason, Runner, tool, started and ended, exit, tokens in and out, summary, session id', async () => {
    const before = Date.now();
    const w = await startRun();
    expect((await agentComments(w)).statusCode).toBe(201);
    const res = await finish(w, { usage: { tokens_in: 1200, tokens_out: 340 }, session_id: 'sess-1', summary: 'Triaged the ticket and replied.', tool_version: '2.1.105' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'done', requeued: false, repeated: false });
    const run = await runRecord(w.run_id!);
    const v = run.values;
    expect(labelOf(runStatusIds, v.status)).toBe('Succeeded');
    expect(labelOf(exitIds, v.exit)).toBe('OK');
    expect(v).toMatchObject({
      wake_reason: 'manual',
      runner: MACHINE,
      tool: 'claude-code',
      tool_version: '2.1.105',
      tokens_in: 1200,
      tokens_out: 340,
      summary: 'Triaged the ticket and replied.',
      session_id: 'sess-1',
      input_record: w.ticket,
    });
    expect((v.agent as Array<{ id: string }>)[0].id).toBe(agent); // the Agent relation
    expect(new Date(v.started_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000); // STARTED at the claim, not queued earlier
    expect(new Date(v.finished_at as string).getTime()).toBeGreaterThanOrEqual(new Date(v.started_at as string).getTime());
    expect(v.limit_resumes_at ?? null).toBeNull();
    expect(await stepsText(w.run_id!)).toContain('tokens in 1200, out 340');
  });

  it('Started at is when a Runner FIRST took the run, not when it was queued; a later resume does not move it', async () => {
    const ticket = await mkTicket('queued early');
    const queuedAt = Date.now();
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket.id })).statusCode).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(queuedAt + 3_600_000)); // an hour later a Runner picks it up
    const w = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    const startedAt = new Date((await runRecord(w.run_id!)).values.started_at as string).getTime();
    expect(startedAt).toBeGreaterThanOrEqual(queuedAt + 3_500_000);
    await finish(w, { exit: 'limit_reached', limit_reached_until: new Date(queuedAt + 3_600_000 + 60_000).toISOString() });
    vi.setSystemTime(new Date(queuedAt + 7_200_000));
    const again = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    expect(again.id).toBe(w.id);
    expect(new Date((await runRecord(w.run_id!)).values.started_at as string).getTime()).toBe(startedAt);
    vi.useRealTimers();
  });

  it('usage the tool did not report is EMPTY, never zero; a reported zero is stored as the zero the tool reported', async () => {
    const w = await startRun();
    await agentComments(w);
    await finish(w, { usage: null });
    const v = (await runRecord(w.run_id!)).values;
    expect(v.tokens_in ?? null).toBeNull();
    expect(v.tokens_out ?? null).toBeNull();
    expect(await stepsText(w.run_id!)).toContain('tokens not reported by the tool');
    const z = await startRun();
    await agentComments(z);
    await finish(z, { usage: { tokens_in: 0, tokens_out: 0 } });
    expect((await runRecord(z.run_id!)).values).toMatchObject({ tokens_in: 0, tokens_out: 0 });
    const omitted = await startRun();
    await agentComments(omitted);
    await finish(omitted); // the field absent altogether
    expect((await runRecord(omitted.run_id!)).values.tokens_in ?? null).toBeNull();
  });

  it('a failed, timed-out or aborted run records its exit, error and summary', async () => {
    for (const [exit, status, label] of [['error', 'Failed', 'Error'], ['timeout', 'Failed', 'Timeout'], ['aborted', 'Canceled', 'Aborted']] as const) {
      const w = await startRun();
      const res = await finish(w, { exit, error: 'the tool crashed', summary: 'half done', usage: { tokens_in: 5, tokens_out: 6 } });
      expect(res.statusCode, res.body).toBe(200);
      const v = (await runRecord(w.run_id!)).values;
      expect(labelOf(runStatusIds, v.status)).toBe(status);
      expect(labelOf(exitIds, v.exit)).toBe(label);
      expect(v).toMatchObject({ summary: 'half done', tokens_in: 5, tokens_out: 6, runner: MACHINE });
      expect(await stepsText(w.run_id!)).toContain('the tool crashed');
    }
  });

  it('the tool version falls back to the one the Runner detected, and a long summary is cut AND says so', async () => {
    const w = await startRun();
    await agentComments(w);
    await finish(w, { summary: 'x'.repeat(5000) });
    const v = (await runRecord(w.run_id!)).values;
    expect(v.tool_version).toBe('2.1.104');
    expect(String(v.summary)).toContain('summary cut: 5000 characters reported');
    expect(String(v.summary).length).toBeLessThan(2300);
  });

  it('a person cannot write the run record fields, and neither can the agent: they are the runtime\'s', async () => {
    const w = await startRun();
    for (const key of ['tokens_in', 'tokens_out', 'exit', 'runner', 'tool', 'tool_version', 'summary', 'session_id', 'limit_resumes_at', 'wake_reason']) {
      const value = key === 'tokens_in' || key === 'tokens_out' ? 7 : key === 'limit_resumes_at' ? new Date().toISOString() : 'forged';
      const byAdmin = await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${runsDbId}/records/${w.run_id}`, { values: { [key]: value } });
      expect(byAdmin.statusCode, `${key}: ${byAdmin.body}`).toBe(422);
      const byAgent = await as(w.credential.token, 'PATCH', `/workspaces/${ws}/databases/${runsDbId}/records/${w.run_id}`, { values: { [key]: value } });
      expect([403, 422], `${key}: ${byAgent.body}`).toContain(byAgent.statusCode);
    }
    expect((await runRecord(w.run_id!)).values.tokens_in ?? null).toBeNull();
    await agentComments(w);
    await finish(w);
  });

  it('a workspace whose Runs database predates these fields gets them back-filled by ensure, once', async () => {
    const names = ['wake_reason', 'runner', 'tool', 'tool_version', 'exit', 'tokens_in', 'tokens_out', 'summary', 'session_id', 'limit_resumes_at'];
    await pool.query('delete from fields where database_id = $1 and api_name = any($2)', [runsDbId, names]);
    expect((await pool.query('select count(*)::int n from fields where database_id = $1 and api_name = any($2)', [runsDbId, names])).rows[0].n).toBe(0);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
    const rows = (await pool.query('select api_name, type from fields where database_id = $1 and api_name = any($2) order by api_name', [runsDbId, names])).rows;
    expect(rows.map((r: { api_name: string }) => r.api_name).sort()).toEqual([...names].sort()); // one of each, no duplicates
    expect(Object.fromEntries(rows.map((r: { api_name: string; type: string }) => [r.api_name, r.type]))).toMatchObject({ tokens_in: 'number', tokens_out: 'number', exit: 'select', limit_resumes_at: 'date' });
    exitIds = Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [runsDbId, 'exit'])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  });
});

describe('AC2: limit reached shows the resume time and requeues AT it (controlled clock)', () => {
  it('stops at the limit, shows when it resumes, is NOT claimable before then and IS claimable after, same Run, tokens added up', async () => {
    const w = await startRun();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date();
    const until = new Date(t0.getTime() + 2 * 3_600_000);
    const res = await finish(w, { exit: 'limit_reached', limit_reached_until: until.toISOString(), usage: { tokens_in: 100, tokens_out: 50 }, summary: 'ran out of subscription' });
    expect(res.json()).toMatchObject({ status: 'queued', requeued: true, repeated: false });
    const run = await runRecord(w.run_id!);
    expect(labelOf(runStatusIds, run.values.status)).toBe('Queued');
    expect(labelOf(exitIds, run.values.exit)).toBe('Limit reached');
    expect(new Date(run.values.limit_resumes_at as string).toISOString()).toBe(until.toISOString());
    expect(run.values).toMatchObject({ tokens_in: 100, tokens_out: 50 });
    expect(await stepsText(w.run_id!)).toContain('Limit reached');
    // The state a person reads: waiting for the limit, with the time.
    const listed = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json().data.find((x: { id: string }) => x.id === w.id);
    expect(listed.run_state).toMatchObject({ state: 'waiting_for_limit', tool: 'claude-code', runner_name: MACHINE });
    expect(new Date(listed.run_state.until).toISOString()).toBe(until.toISOString());
    // One second before: nothing.
    vi.setSystemTime(new Date(until.getTime() - 1000));
    expect((await claim(runner.token)).statusCode).toBe(204);
    expect((await wakeRow(w.id)).status).toBe('queued');
    // At it: the SAME wake and the SAME Run come back, with a fresh nonce and a fresh credential.
    vi.setSystemTime(new Date(until.getTime() + 1000));
    const again = await claim(runner.token);
    expect(again.statusCode, again.body).toBe(200);
    const next = (again.json() as { wakes: Claimed[] }).wakes[0]!;
    expect(next.id).toBe(w.id);
    expect(next.run_id).toBe(w.run_id);
    expect(next.nonce).not.toBe(w.nonce);
    expect(next.credential.token).not.toBe(w.credential.token);
    expect(labelOf(runStatusIds, (await runRecord(w.run_id!)).values.status)).toBe('Running');
    expect((await agentComments({ ...next, ticket: w.ticket })).statusCode).toBe(201);
    const done = await finish(next, { usage: { tokens_in: 20, tokens_out: 10 } });
    expect(done.json()).toMatchObject({ status: 'done' });
    const v = (await runRecord(w.run_id!)).values;
    expect(labelOf(runStatusIds, v.status)).toBe('Succeeded');
    expect(v).toMatchObject({ tokens_in: 120, tokens_out: 60 }); // the attempts, as reported, added up
    expect(await stepsText(w.run_id!)).toContain('tokens in 100, out 50'); // and each attempt still readable
  });

  it('the paused Runner claims NOTHING for its other agents either until then; another Runner is unaffected', async () => {
    const second = await mkAgent(owner, 'Second agent');
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${second}`, { runner_id: runner.id });
    const w = await startRun();
    await finish(w, { exit: 'limit_reached', limit_reached_until: new Date(Date.now() + 3_600_000).toISOString() });
    const t = await mkTicket('for the second agent');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${second}/delegate`, { record_id: t.id });
    expect((await claim(runner.token)).statusCode).toBe(204);
    const theirs = await mkAgent(other, 'Other agent');
    await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${theirs}`, { runner_id: otherRunner.id });
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${theirs}/delegate`, { record_id: t.id });
    expect((await claim(otherRunner.token)).statusCode).toBe(200);
  });

  it('when the tool states no time the fallback is the named 1 hour AND the Run says it was not the tool\'s time', async () => {
    const w = await startRun();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date();
    const res = await finish(w, { exit: 'limit_reached' });
    expect(new Date(res.json().not_before).getTime()).toBe(t0.getTime() + WAKE_LIMIT_FALLBACK_MS);
    const v = (await runRecord(w.run_id!)).values;
    expect(new Date(v.limit_resumes_at as string).getTime()).toBe(t0.getTime() + WAKE_LIMIT_FALLBACK_MS);
    expect(await stepsText(w.run_id!)).toContain('did not say when');
  });

  it('a stated time that already passed is not trusted (no tight loop); one years away is cut to 7 days; each says so', async () => {
    const past = await startRun();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date();
    const r1 = await finish(past, { exit: 'limit_reached', limit_reached_until: new Date(t0.getTime() - 60_000).toISOString() });
    expect(new Date(r1.json().not_before).getTime()).toBe(t0.getTime() + WAKE_LIMIT_FALLBACK_MS);
    expect(await stepsText(past.run_id!)).toContain('had already passed');
    vi.useRealTimers();
    await pool.query('update runners set paused_until = null where id = $1', [runner.id]);
    await pool.query('update agent_wakes set status = $2, finished_at = now() where id = $1', [past.id, 'canceled']);
    const far = await startRun();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t1 = new Date();
    const r2 = await finish(far, { exit: 'limit_reached', limit_reached_until: '2099-01-01T00:00:00.000Z' });
    expect(new Date(r2.json().not_before).getTime()).toBe(t1.getTime() + WAKE_LIMIT_MAX_MS);
    expect((await pool.query('select paused_until from runners where id = $1', [runner.id])).rows[0].paused_until.getTime()).toBe(t1.getTime() + WAKE_LIMIT_MAX_MS);
    expect(await stepsText(far.run_id!)).toContain('more than 7 days away');
  });

  it('a second, SHORTER limit never shortens a longer pause the Runner already has', async () => {
    const w = await startRun();
    const long = new Date(Date.now() + 5 * 3_600_000);
    await finish(w, { exit: 'limit_reached', limit_reached_until: long.toISOString() });
    await pool.query("update agent_wakes set not_before = now() where id = $1", [w.id]); // make the wake itself claimable
    await pool.query('update runners set paused_until = $2 where id = $1', [runner.id, long]);
    // A different wake on another agent of the same Runner reports a shorter limit while the Runner was (in the test) running it.
    const second = await mkAgent(owner, 'Shorter');
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${second}`, { runner_id: runner.id });
    const t = await mkTicket('short');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${second}/delegate`, { record_id: t.id });
    await pool.query('update runners set paused_until = null where id = $1', [runner.id]);
    const got = (await claim(runner.token)).json() as { wakes: Claimed[] };
    await pool.query('update runners set paused_until = $2 where id = $1', [runner.id, long]);
    const res = await finish(got.wakes[0]!, { exit: 'limit_reached', limit_reached_until: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect((await pool.query('select paused_until from runners where id = $1', [runner.id])).rows[0].paused_until.getTime()).toBe(long.getTime());
  });

  it('a wake whose own time is later than the Runner\'s pause still reads waiting_for_limit until ITS time', async () => {
    const w = await startRun();
    const until = new Date(Date.now() + 4 * 3_600_000);
    await finish(w, { exit: 'limit_reached', limit_reached_until: until.toISOString() });
    await pool.query('update runners set paused_until = null where id = $1', [runner.id]); // e.g. an operator cleared the pause
    const listed = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json().data.find((x: { id: string }) => x.id === w.id);
    expect(listed.run_state.state).toBe('waiting_for_limit');
    expect(new Date(listed.run_state.until).toISOString()).toBe(until.toISOString());
    expect((await claim(runner.token)).statusCode).toBe(204); // its own not_before still holds it
  });
});

describe('AC3: the must-comment backstop', () => {
  it('a run that ends OK with no comment is woken ONCE more with that reason; ending again without one FAILS it visibly and tells the owner once', async () => {
    const w = await startRun();
    const first = await finish(w, { usage: { tokens_in: 10, tokens_out: 5 }, summary: 'forgot to say anything' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: 'queued', requeued: true, must_comment: 'rewoken' });
    const row = await wakeRow(w.id);
    expect(row.status).toBe('queued');
    expect((row.reasons as Array<{ reason: string }>).map((r) => r.reason)).toContain('must_comment');
    expect(await runStatus(w.run_id!)).toBe('Queued');
    expect(await stepsText(w.run_id!)).toContain('without commenting');
    expect(await failedNotes(ownerId, w.ticket)).toBe(0); // not told yet: it has a second go
    // The re-wake is claimable at once, with a fresh credential, and carries the reason.
    const again = await claim(runner.token);
    expect(again.statusCode, again.body).toBe(200);
    const next = (again.json() as { wakes: Array<Claimed & { reasons: Array<{ reason: string }> }> }).wakes[0]!;
    expect(next.id).toBe(w.id);
    expect(next.reasons.map((r) => r.reason)).toContain('must_comment');
    const second = await finish(next, { summary: 'again nothing' });
    expect(second.json()).toMatchObject({ status: 'failed', requeued: false, must_comment: 'failed' });
    expect((await wakeRow(w.id)).status).toBe('failed');
    const run = await runRecord(w.run_id!);
    expect(labelOf(runStatusIds, run.values.status)).toBe('Failed');
    expect(await stepsText(w.run_id!)).toContain('second time');
    expect(run.values).toMatchObject({ tokens_in: 10, tokens_out: 5 }); // the first attempt's tokens kept; the second reported none
    expect(await failedNotes(ownerId, w.ticket)).toBe(1); // the manager (the agent's owner), once
    expect(await failedNotes(otherId, w.ticket)).toBe(0);
    expect(await failedNotes((await as(admin.token, 'GET', '/me')).json().id, w.ticket)).toBe(0);
    // Nothing is left to run, and a retry of the last report does not tell anyone again.
    expect((await claim(runner.token)).statusCode).toBe(204);
    expect((await finish(next, { summary: 'again nothing' })).json()).toMatchObject({ status: 'failed', repeated: true });
    expect(await failedNotes(ownerId, w.ticket)).toBe(1);
  });

  it('a run that DID comment on its record is not re-woken and is Succeeded', async () => {
    const w = await startRun();
    expect((await agentComments(w)).statusCode).toBe(201);
    const res = await finish(w);
    expect(res.json()).toMatchObject({ status: 'done', requeued: false });
    expect(res.json().must_comment).toBeUndefined();
    expect((await wakeRow(w.id)).reasons.map((r: { reason: string }) => r.reason)).not.toContain('must_comment');
    expect(await runStatus(w.run_id!)).toBe('Succeeded');
    expect((await claim(runner.token)).statusCode).toBe(204);
    expect(await failedNotes(ownerId, w.ticket)).toBe(0);
  });

  it('what does NOT count as the run commenting: a person\'s comment, the agent\'s comment on ANOTHER record, a deleted comment, an earlier run\'s comment', async () => {
    // an earlier run of the same agent on the same record commented: that is not THIS run's comment
    const w = await startRun();
    await agentComments(w, 'first run comment');
    await finish(w);
    expect(await runStatus(w.run_id!)).toBe('Succeeded');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: w.ticket });
    const w2 = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    expect(w2.id).not.toBe(w.id);
    // a human comments on the record during the run
    await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}/comments`, { body: { format: 'blocknote', doc: [txt('a person speaking')] } });
    // the agent comments on a DIFFERENT record
    const elsewhere = await mkTicket('elsewhere');
    await agentComments({ ...w2, ticket: elsewhere.id }, 'wrong record');
    // and comments on this one, then that comment is deleted
    const mine = await agentComments({ ...w2, ticket: w.ticket }, 'to be deleted');
    expect(mine.statusCode).toBe(201);
    await pool.query('update comments set deleted_at = now() where id = $1', [mine.json().id]);
    const res = await finish(w2);
    expect(res.json()).toMatchObject({ status: 'queued', must_comment: 'rewoken' });
  });

  it('the re-woken run that comments ends Succeeded, and the comment written BEFORE a limit stop counts for the Run', async () => {
    const w = await startRun();
    await finish(w, { summary: 'silent' });
    const next = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    expect((await agentComments({ ...next, ticket: w.ticket })).statusCode).toBe(201);
    expect((await finish(next, { usage: { tokens_in: 3, tokens_out: 4 } })).json()).toMatchObject({ status: 'done' });
    expect(await runStatus(w.run_id!)).toBe('Succeeded');
    expect(await failedNotes(ownerId, w.ticket)).toBe(0);

    const limited = await startRun();
    await agentComments(limited, 'progress note before the limit');
    await finish(limited, { exit: 'limit_reached', limit_reached_until: new Date(Date.now() + 1000).toISOString() });
    await pool.query('update agent_wakes set not_before = now() where id = $1', [limited.id]);
    await pool.query('update runners set paused_until = null where id = $1', [runner.id]);
    const resumed = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    expect((await finish(resumed)).json()).toMatchObject({ status: 'done', requeued: false }); // no new comment needed: the Run already commented
  });

  it('error, timeout and aborted ends are already visible failures: no backstop', async () => {
    for (const exit of ['error', 'timeout', 'aborted'] as const) {
      const w = await startRun();
      const res = await finish(w, { exit });
      expect(res.json().must_comment).toBeUndefined();
      expect(res.json().requeued).toBe(false);
      expect((await wakeRow(w.id)).reasons.map((r: { reason: string }) => r.reason)).not.toContain('must_comment');
    }
  });

  it('a wake with NO record has nothing to comment on: exempt, Succeeded', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    const w = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    const done = await finish(w);
    expect(done.json()).toMatchObject({ status: 'done', requeued: false });
    expect(await runStatus(w.run_id!)).toBe('Succeeded');
  });

  it('a mention that arrived mid-run is not lost: the must-comment re-wake keeps it, and ONE fresh wake follows the finished one', async () => {
    const w = await startRun();
    const mention = { type: 'paragraph', content: [{ type: 'mention', props: { kind: 'agent', id: agent, label: 'agent' } }, { type: 'text', text: ' one more thing', styles: {} }] };
    await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}/comments`, { body: { format: 'blocknote', doc: [mention] } });
    expect(await wakeRow(w.id)).toMatchObject({ status: 'claimed', rewake: true });
    await finish(w);
    expect(await wakeRow(w.id)).toMatchObject({ status: 'queued', rewake: true });
    const next = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    await agentComments({ ...next, ticket: w.ticket });
    await finish(next);
    const open = (await pool.query("select id from agent_wakes where agent_id = $1 and status = 'queued'", [agent])).rows;
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(w.id);
  });
});

describe('idempotent and refused completions, and the credential', () => {
  it('the same completion twice is the same answer and writes the Run once (no double-counted tokens)', async () => {
    const w = await startRun();
    await agentComments(w);
    const body = { usage: { tokens_in: 7, tokens_out: 8 }, summary: 'once' };
    const a = await finish(w, body);
    const b = await finish(w, body);
    expect(a.json()).toMatchObject({ status: 'done', repeated: false });
    expect(b.json()).toMatchObject({ status: 'done', repeated: true });
    expect((await runRecord(w.run_id!)).values).toMatchObject({ tokens_in: 7, tokens_out: 8 });
  });

  it('a retry of a limit completion (dropped response) is answered, not 409, and is not counted or paused twice', async () => {
    const w = await startRun();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const body = { exit: 'limit_reached', limit_reached_until: until, usage: { tokens_in: 9, tokens_out: 9 } };
    expect((await finish(w, body)).json()).toMatchObject({ status: 'queued', requeued: true, repeated: false });
    const retry = await finish(w, body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'queued', repeated: true });
    expect((await runRecord(w.run_id!)).values).toMatchObject({ tokens_in: 9, tokens_out: 9 });
  });

  it('a retry of the first must-comment completion is answered too, and does not enqueue or notify anything', async () => {
    const w = await startRun();
    expect((await finish(w, { usage: { tokens_in: 1, tokens_out: 1 } })).json()).toMatchObject({ must_comment: 'rewoken' });
    const retry = await finish(w, { usage: { tokens_in: 1, tokens_out: 1 } });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'queued', repeated: true });
    expect((await runRecord(w.run_id!)).values).toMatchObject({ tokens_in: 1, tokens_out: 1 });
    expect((await pool.query("select count(*)::int n from agent_wakes where agent_id = $1 and record_id = $2", [agent, w.ticket])).rows[0].n).toBe(1);
  });

  it('after a re-claim the OLD nonce is a clear 409 lease_lost and changes nothing', async () => {
    const w = await startRun();
    await finish(w); // must-comment: back to the queue
    const next = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    const stale = await finish(w, { summary: 'stale' });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('lease_lost');
    expect((await wakeRow(w.id)).status).toBe('claimed');
    await agentComments({ ...next, ticket: w.ticket });
    await finish(next);
  });

  it('another Runner (someone else\'s token) cannot complete or read the result of this wake: 409, nothing written', async () => {
    const w = await startRun();
    const res = await finish(w, { summary: 'hijack', usage: { tokens_in: 999, tokens_out: 999 } }, otherRunner.token);
    expect(res.statusCode).toBe(409);
    expect((await wakeRow(w.id)).status).toBe('claimed');
    expect((await runRecord(w.run_id!)).values.tokens_in ?? null).toBeNull();
    await agentComments(w);
    await finish(w);
  });

  it('no sign-in, a person\'s session, a PAT and the run credential itself are all refused on complete', async () => {
    const w = await startRun();
    const body = { nonce: w.nonce, exit: 'ok' };
    expect((await app.inject({ method: 'POST', url: `/api/v1/runner/v1/wakes/${w.id}/complete`, payload: body as never })).statusCode).toBe(401);
    for (const token of [owner.token, admin.token, w.credential.token]) {
      const res = await asRunner(token, 'POST', `/runner/v1/wakes/${w.id}/complete`, body);
      expect([401, 403], res.body).toContain(res.statusCode);
    }
    expect((await wakeRow(w.id)).status).toBe('claimed');
    await agentComments(w);
    await finish(w);
  });

  it('the credential dies at completion (a later call is 401), also at the must-comment requeue; the re-woken run gets a new one that works', async () => {
    const w = await startRun();
    expect((await agentComments(w)).statusCode).toBe(201);
    await finish(w);
    expect((await agentComments(w)).statusCode).toBe(401);
    const silent = await startRun();
    await finish(silent);
    expect((await agentComments(silent)).statusCode).toBe(401); // the old credential, after the requeue
    const next = ((await claim(runner.token)).json() as { wakes: Claimed[] }).wakes[0]!;
    expect((await agentComments({ ...next, ticket: silent.ticket })).statusCode).toBe(201);
    await finish(next);
  });

  it('a credential past its lease is refused by the clock, but the Runner can still report what happened', async () => {
    const w = await startRun();
    await pool.query("update api_tokens set expires_at = now() - interval '1 second' where runner_id is not null and revoked_at is null and run_id = $1", [w.run_id]);
    expect((await agentComments(w)).statusCode).toBe(401);
    const res = await finish(w, { exit: 'error', error: 'lost the lease to the clock' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await runStatus(w.run_id!)).toBe('Failed');
  });

  it('an agent owned by a guest is never claimed, so it can never reach a completion', async () => {
    const guestAgent = await mkAgent(guest, 'Guest agent').catch(() => null);
    if (!guestAgent) return; // a guest may not create Agents records at all: the stricter answer
    await as(admin.token, 'PUT', `/workspaces/${ws}/runner-assignments/${guestAgent}`, { runner_id: runner.id });
    const t = await mkTicket('guest ticket');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${guestAgent}/delegate`, { record_id: t.id });
    expect((await claim(runner.token)).statusCode).toBe(204);
  });
});

describe('the pure rules', () => {
  const now = new Date('2026-10-30T10:00:00.000Z');
  it('resolveLimitUntil: the tool\'s time when usable, else the named fallback, else the cap', () => {
    expect(resolveLimitUntil('2026-10-30T12:00:00.000Z', now)).toEqual({ until: new Date('2026-10-30T12:00:00.000Z'), source: 'tool' });
    expect(resolveLimitUntil(undefined, now)).toMatchObject({ source: 'fallback_missing' });
    expect(resolveLimitUntil('not a time', now)).toMatchObject({ source: 'fallback_missing' });
    expect(resolveLimitUntil('2026-10-30T09:00:00.000Z', now)).toMatchObject({ source: 'fallback_past' });
    expect(resolveLimitUntil('2026-10-30T10:00:00.000Z', now)).toMatchObject({ source: 'fallback_past' }); // exactly now is not in the future
    expect(resolveLimitUntil('2027-01-01T00:00:00.000Z', now)).toEqual({ until: new Date(now.getTime() + WAKE_LIMIT_MAX_MS), source: 'clamped_future' });
  });
  it('addUsage never turns "not reported" into zero', () => {
    expect(addUsage(null, null)).toBeNull();
    expect(addUsage(5, null)).toBe(5);
    expect(addUsage(null, 0)).toBe(0);
    expect(addUsage(5, 7)).toBe(12);
  });
  it('capSummary is empty for nothing and says so when it cuts', () => {
    expect(capSummary(undefined)).toBeNull();
    expect(capSummary('   ')).toBeNull();
    expect(capSummary('short')).toBe('short');
    expect(capSummary('y'.repeat(2001))).toContain('summary cut: 2001');
  });
});
