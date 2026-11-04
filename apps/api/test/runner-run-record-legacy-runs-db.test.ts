import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import { RUNNER_RUN_FIELD_NAMES } from '../src/runners/run-record';
import { RecordsService } from '../src/records/records.service';

/**
 * ticket #1214 — the first production Runner run (JCM, Onboarding Assistant, state change) finished `done` with `run_id` null and
 * `agentic_os/runs` empty. JCM's Runs database predates ticket #1133: it has none of the Runner's run-record fields (`wake_reason`,
 * `runner`, `tokens_in` ...). The state-change dispatch does not re-ensure the pack, so creating the Run failed AFTER the wake was
 * already queued, the wake stayed queued with no Run, and a Runner claimed and finished it. The rig every earlier test used is a
 * workspace made on the current code, which has every field, so it could not show this. THIS rig strips them, like JCM.
 */
let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let stateFieldId: string;
let stateApi: string;
let reviewId: string;
let doneId: string;
let admin: { token: string; email: string };
let owner: Person;
let aiModeIds: Record<string, string> = {};
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = () => ({ machine_name: "Owner's MacBook", tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const wakeRows = async (agentId: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agentId])).rows;
const runsCount = async () => (await pool.query('select count(*)::int n from records where database_id = $1 and deleted_at is null', [runsDbId])).rows[0].n as number;

async function mkAgent(name: string): Promise<string> {
  const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true, ai_mode: aiModeIds['Your own AI'] } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function bindState(agentId: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent: agentId, database_id: ticketsDbId, state_field_id: stateFieldId, state_option_id: reviewId });
  expect(res.statusCode, res.body).toBe(201);
}
async function pairRunner(who: Person, agentIds: string[]) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(who.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  for (const agent of agentIds) {
    expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id })).statusCode).toBe(200);
  }
  return { token, id: runner.id };
}
async function moveToReview(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name, [stateApi]: doneId } });
  expect(res.statusCode, res.body).toBe(201);
  const ticket = res.json().id as string;
  await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [stateApi]: reviewId } });
  await subscriber.settle(ticket);
  return ticket;
}
/** The agent says something on the record (the must-comment backstop is not what these tests are about). */
async function agentSaid(wakeId: string) {
  const w = (await pool.query('select record_id, run_id, agent_id from agent_wakes where id = $1', [wakeId])).rows[0];
  await pool.query("insert into comments (record_id, author_id, body, source, agent_id, run_id) values ($1, 'test-author', '[]'::jsonb, 'agent', $2, $3)", [w.record_id, w.agent_id, w.run_id]);
}
const stripRunnerFields = () => pool.query('delete from fields where database_id = $1 and api_name = any($2)', [runsDbId, [...RUNNER_RUN_FIELD_NAMES]]);
const runnerFieldCount = async () => (await pool.query('select count(*)::int n from fields where database_id = $1 and api_name = any($2)', [runsDbId, [...RUNNER_RUN_FIELD_NAMES]])).rows[0].n as number;

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'LegacyRunsAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Legacy Runs WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  const state = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'State', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'Review' }, { label: 'Done' }] })).json();
  stateFieldId = state.id;
  stateApi = state.apiName;
  reviewId = state.options.find((o: { label: string }) => o.label === 'Review').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;
  owner = await joinAs(app, admin.token, ws, 'LegacyOwner', 'member');
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('ticket #1214: a Runs database that predates the Runner run-record fields (JCM)', () => {
  it('a state change wakes the agent WITH a Run, a Runner claims it, and completion writes tokens, session id and summary on that Run', async () => {
    const agent = await mkAgent('Onboarding Assistant');
    await bindState(agent);
    const runner = await pairRunner(owner, [agent]);
    // JCM: the agent, its trigger and its Runner were all set up on code that predates #1133, and nothing has ensured the pack since.
    expect(await runnerFieldCount()).toBe(RUNNER_RUN_FIELD_NAMES.length); // (the fixture starts from today's workspace ...)
    await stripRunnerFields();
    expect(await runnerFieldCount()).toBe(0); // ... and is made JCM-shaped HERE, just before the state change
    const ticket = await moveToReview('Acme Co (sample)');

    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'state_change', record_id: ticket });
    expect(rows[0].run_id, 'the wake has no Run record').not.toBeNull();
    expect(await runsCount()).toBe(1);

    const claimed = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const got = claimed.json().wakes[0];
    expect(got.run_id).toBe(rows[0].run_id);
    await agentSaid(rows[0].id);
    const done = await asRunner(runner.token, 'POST', `/runner/v1/wakes/${rows[0].id}/complete`, {
      nonce: got.nonce,
      exit: 'ok',
      summary: 'Welcomed the customer',
      session_id: 'sess-1214',
      usage: { tokens_in: 1200, tokens_out: 340 },
      tool_version: '2.1.104',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'done' });
    const run = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${rows[0].run_id}`)).json() as { values: Record<string, unknown> };
    expect(run.values).toMatchObject({ tokens_in: 1200, tokens_out: 340, session_id: 'sess-1214', summary: 'Welcomed the customer', tool: 'claude-code' });
  });

  it('a Run that cannot be written never leaves a QUEUED wake behind: the wake fails and the trigger says why', async () => {
    const agent = await mkAgent('Unwritable runs bot');
    await bindState(agent);
    await pairRunner(owner, [agent]);
    const records = app.get(RecordsService);
    const real = records.create.bind(records);
    const spy = vi.spyOn(records, 'create').mockImplementation(async (workspaceId, databaseId, ...rest) => {
      if (databaseId === runsDbId) throw new Error('simulated: the Runs database refused the record');
      return real(workspaceId, databaseId, ...rest);
    });
    try {
      await moveToReview('Unwritable ticket');
    } finally {
      spy.mockRestore();
    }
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].status, 'a queued wake with no Run is a job nothing can show').toBe('failed');
    expect(rows[0].run_id).toBeNull();
  });

  it('a wake that reaches a claim with NO Run (made before this fix) is given one, so the run is on the agent page', async () => {
    const agent = await mkAgent('Orphan wake bot');
    const runner = await pairRunner(owner, [agent]);
    const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: 'Orphan ticket' } })).json().id as string;
    const before = await runsCount();
    const inserted = await pool.query(
      `insert into agent_wakes (workspace_id, agent_id, record_id, reason, requested_by, depth, reasons, expires_at)
       values ($1, $2, $3, 'state_change', $4, 0, '[{"reason":"state_change","count":1,"last_at":"2026-11-04T21:08:07.907Z"}]'::jsonb, now() + interval '7 days') returning id`,
      [ws, agent, ticket, owner.id],
    );
    const wakeId = inserted.rows[0].id as string;
    const claimed = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const got = claimed.json().wakes[0];
    expect(got.id).toBe(wakeId);
    expect(got.run_id, 'handed to the Runner without a Run').not.toBeNull();
    expect(await runsCount()).toBe(before + 1);
    expect((await wakeRows(agent))[0].run_id).toBe(got.run_id);
    await agentSaid(wakeId);
    const done = await asRunner(runner.token, 'POST', `/runner/v1/wakes/${wakeId}/complete`, { nonce: got.nonce, exit: 'ok', summary: 'Healed', session_id: 'sess-heal', usage: { tokens_in: 10, tokens_out: 5 } });
    expect(done.statusCode, done.body).toBe(200);
    const run = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${got.run_id}`)).json() as { values: Record<string, unknown> };
    expect(run.values).toMatchObject({ tokens_in: 10, tokens_out: 5, session_id: 'sess-heal', summary: 'Healed' });
  });

  it('a claim whose Run cannot be made FAILS the wake and tells the owner: never handed over, never done with run_id null', async () => {
    const agent = await mkAgent('Unhealable wake bot');
    const runner = await pairRunner(owner, [agent]);
    const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: 'Unhealable ticket' } })).json().id as string;
    const inserted = await pool.query(
      `insert into agent_wakes (workspace_id, agent_id, record_id, reason, requested_by, depth, reasons, expires_at)
       values ($1, $2, $3, 'state_change', $4, 0, '[{"reason":"state_change","count":1,"last_at":"2026-11-04T21:08:07.907Z"}]'::jsonb, now() + interval '7 days') returning id`,
      [ws, agent, ticket, owner.id],
    );
    const wakeId = inserted.rows[0].id as string;
    const records = app.get(RecordsService);
    const real = records.create.bind(records);
    const spy = vi.spyOn(records, 'create').mockImplementation(async (workspaceId, databaseId, ...rest) => {
      if (databaseId === runsDbId) throw new Error('simulated: the Runs database refused the record');
      return real(workspaceId, databaseId, ...rest);
    });
    let claimed;
    try {
      claimed = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(claimed.statusCode, 'nothing may be handed to the Runner').toBe(204);
    const row = (await wakeRows(agent)).find((w: { id: string }) => w.id === wakeId);
    expect(row.status).toBe('failed');
    const notes = await pool.query("select count(*)::int n from notifications where type = 'agent_wake_failed' and user_id = $1 and record_id = $2", [owner.id, ticket]);
    expect(notes.rows[0].n).toBe(1);
  });

  it('a Run created BEFORE the Runner fields existed still receives tokens, session id and summary at completion', async () => {
    const agent = await mkAgent('Old run bot');
    await bindState(agent);
    const runner = await pairRunner(owner, [agent]);
    await moveToReview('Old run ticket'); // the Run is made with the fields ...
    await stripRunnerFields(); // ... and they are gone by the time the Runner reports (a Runs database from before #1133)
    expect(await runnerFieldCount()).toBe(0);
    const w = (await wakeRows(agent))[0];
    const claimed = await asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
    const got = claimed.json().wakes[0];
    await agentSaid(w.id);
    const done = await asRunner(runner.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit: 'ok', summary: 'Late', session_id: 'sess-old', usage: { tokens_in: 7, tokens_out: 3 } });
    expect(done.statusCode, done.body).toBe(200);
    const run = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${w.run_id}`)).json() as { values: Record<string, unknown> };
    expect(run.values).toMatchObject({ tokens_in: 7, tokens_out: 3, session_id: 'sess-old', summary: 'Late' });
  });
});
