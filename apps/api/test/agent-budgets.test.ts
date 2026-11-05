import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentBudgetService } from '../src/runners/agent-budget.service';
import { AiFieldSubscriber } from '../src/records/ai-field.subscriber';
import { JobRunnerService } from '../src/automations/job-runner.service';

/**
 * ticket #1138 — budgets per agent, in tokens and in runs: warn at 80% (once), pause at 100%, raising the budget resumes it.
 * Real fixtures: an admin, the Runner's owner (a member, who also owns the agents), another member, a guest with only an Agents grant
 * and a guest with no grant at all. Every claim, completion and notice is the real thing, read back from the database.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let admin: { token: string; email: string };
let owner: Person;
let other: Person;
let agentsOnlyGuest: Person;
let ownerId = '';
let runner: { token: string; id: string };
let aiOwn = '';
let scopeWrite = '';
const { pool } = connectTestDb();
vi.setConfig({ testTimeout: 120_000 });

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const claim = (max = 1) => asRunner(runner.token, 'POST', '/runner/v1/claim', { wait_seconds: 0, max });
type Claimed = { id: string; nonce: string; run_id: string; agent: { id: string }; credential: { token: string } };
const claimed = (res: { statusCode: number; json: () => unknown }): Claimed[] => (res.statusCode === 200 ? ((res.json() as { wakes: Claimed[] }).wakes ?? []) : []);

async function mkAgent(name: string, budget: { tokens?: number; runs?: number } = {}): Promise<string> {
  const values: Record<string, unknown> = { name, enabled: true, ai_mode: aiOwn, scopes: [scopeWrite] };
  if (budget.tokens !== undefined) values.monthly_token_budget = budget.tokens;
  if (budget.runs !== undefined) values.monthly_run_cap = budget.runs;
  const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${id}`, { runner_id: runner.id })).statusCode).toBe(200);
  return id;
}
/** A fresh wake for the agent (any open one is cancelled first so each call is its own run). */
async function wake(agent: string) {
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1 and status in ('queued','claimed')", [agent]);
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`);
  expect(res.statusCode, res.body).toBe(201);
}
const complete = (w: Claimed, body: Record<string, unknown> = {}) => asRunner(runner.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: w.nonce, exit: 'ok', ...body });
/** One whole run: wake, claim, complete with `tokens` (in + out) or with no usage at all. */
async function runOnce(agent: string, tokens: number | null) {
  await wake(agent);
  const got = claimed(await claim());
  expect(got, 'the agent should have been given the wake').toHaveLength(1);
  const done = await complete(got[0]!, tokens === null ? { summary: 'x' } : { usage: { tokens_in: Math.floor(tokens / 2), tokens_out: tokens - Math.floor(tokens / 2) }, summary: 'x' });
  expect(done.statusCode, done.body).toBe(200);
  return got[0]!;
}
const notes = async (type: string, agent: string) =>
  (await pool.query('select coalesce(sum(count),0)::int n from notifications where type = $1 and user_id = $2 and record_id = $3', [type, ownerId, agent])).rows[0].n as number;
const budget = async (agent: string, who = owner) => (await as(who.token, 'GET', `/workspaces/${ws}/agents/${agent}/budget`)).json() as Record<string, any>;
const setBudget = (agent: string, values: Record<string, unknown>, who: { token: string } = owner) =>
  as(who.token, 'PATCH', `/workspaces/${ws}/databases/${agentsDbId}/records/${agent}`, { values });
const waitingState = async (agent: string) => {
  const res = await as(owner.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`);
  return (res.json().data as Array<{ status: string; run_state: Record<string, any> }>).find((w) => w.status === 'queued')?.run_state;
};

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'BudgetAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Budget WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeWrite = (await opt(agentsDbId, 'scopes')).write!;
  owner = await joinAs(app, admin.token, ws, 'BudgetOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'BudgetOther', 'member');
  agentsOnlyGuest = await joinAs(app, admin.token, ws, 'BudgetGuest', 'guest', [{ database_id: agentsDbId, role: 'viewer' }]);
  ownerId = (await as(owner.token, 'GET', '/me')).json().id;
  const code = (await as(owner.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, machine_name: "Owner's MacBook", tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(owner.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  runner = { token, id: r.id };
}, 400_000);

// Each test starts with an empty queue: a wake a previous test left behind would be claimed first (oldest first) and the run under test would never start.
beforeEach(async () => {
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('AC1: the budget and the usage show on the agent (GET /agents/{agent}/budget)', () => {
  it('shows limits and this month\'s usage from the Run records, before any budget is set and after', async () => {
    const agent = await mkAgent('Shows usage');
    let b = await budget(agent);
    expect(b).toMatchObject({ state: 'none', limits: { tokens: null, runs: null }, tokens: { limit: null, used: 0, measurement: 'no_finished_runs' }, runs: { limit: null, used: 0 } });
    expect(b.agent).toMatchObject({ id: agent, name: 'Shows usage' });
    await runOnce(agent, 300);
    await runOnce(agent, 200);
    expect((await setBudget(agent, { monthly_token_budget: 1000, monthly_run_cap: 10 })).statusCode).toBe(200);
    b = await budget(agent);
    expect(b).toMatchObject({ state: 'ok', limits: { tokens: 1000, runs: 10 }, tokens: { limit: 1000, used: 500, percent: 50, state: 'ok', measurement: 'full', unmeasured_runs: 0 }, runs: { limit: 10, used: 2, percent: 20 } });
    expect(b.period.resets_at > b.period.starts_at).toBe(true);
    expect(b.resumes_at).toBeNull();
  });

  it('counts only the runs a Runner started: a wake still waiting has used nothing', async () => {
    const agent = await mkAgent('Queued only', { runs: 5 });
    await wake(agent);
    expect((await budget(agent)).runs).toMatchObject({ used: 0, percent: 0 });
  });

  it('the summary carries the budget for an agent that has one, and null for one that has none', async () => {
    const withBudget = await mkAgent('Summary with', { tokens: 400 });
    const without = await mkAgent('Summary without');
    const rows = (await as(owner.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json().agents as Array<{ agent_id: string; budget: { state: string; tokens: { limit: number } } | null }>;
    expect(rows.find((a) => a.agent_id === withBudget)!.budget).toMatchObject({ state: 'ok', tokens: { limit: 400 } });
    expect(rows.find((a) => a.agent_id === without)!.budget).toBeNull();
  });

  it('is private like the Agents and Runs databases: a guest with only an Agents grant, and a nonexistent agent, both get the 404 a missing id gets', async () => {
    const agent = await mkAgent('Private', { tokens: 100 });
    expect((await as(agentsOnlyGuest.token, 'GET', `/workspaces/${ws}/agents/${agent}/budget`)).statusCode).toBe(404);
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/agents/00000000-0000-4000-8000-000000000000/budget`)).statusCode).toBe(404);
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/agents/not-a-uuid/budget`)).statusCode).toBe(404);
    expect((await as(other.token, 'GET', `/workspaces/${ws}/agents/${agent}/budget`)).statusCode).toBe(200);
    const row = (await as(agentsOnlyGuest.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json().agents as Array<{ agent_id: string; budget: unknown }>;
    expect(row.find((a) => a.agent_id === agent)?.budget ?? null).toBeNull();
  });
});

describe('AC2: 80% notifies once, 100% pauses claims for that agent', () => {
  it('a token budget: 850 of 1000 warns the manager ONCE (more runs under 100% add no second notice); 1000 pauses and says so once', async () => {
    const agent = await mkAgent('Tokens', { tokens: 1000 });
    await runOnce(agent, 500);
    expect(await notes('agent_budget_warning', agent)).toBe(0);
    await runOnce(agent, 350); // 850: over 80%
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect((await budget(agent)).state).toBe('warning');
    await runOnce(agent, 50); // 900: still under 100%, and the warning does NOT repeat
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect(await notes('agent_budget_paused', agent)).toBe(0);

    await runOnce(agent, 100); // 1000: the budget is used up
    expect(await notes('agent_budget_paused', agent)).toBe(1);
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    const b = await budget(agent);
    expect(b).toMatchObject({ state: 'paused', paused_reason: 'tokens', tokens: { used: 1000, percent: 100, state: 'paused' } });
    expect(b.resumes_at).toBe(b.period.resets_at);
    const sentence = (await pool.query("select snippet from notifications where type = 'agent_budget_paused' and record_id = $1", [agent])).rows[0].snippet as string;
    expect(sentence).toMatch(/Tokens is paused/);
    expect(sentence).toMatch(/raise its budget/);

    // Paused: the next wake is queued, shown as waiting for the budget, and NOT claimed.
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    expect(await waitingState(agent)).toMatchObject({ state: 'waiting_for_budget', budget_metric: 'tokens', until: b.resumes_at });
    // The pause is not announced again by asking again.
    expect(claimed(await claim())).toHaveLength(0);
    expect(await notes('agent_budget_paused', agent)).toBe(1);
  });

  it('only the agent that is over is paused: another agent on the same Runner still claims', async () => {
    const over = await mkAgent('Over', { runs: 1 });
    const fine = await mkAgent('Fine', { runs: 50 });
    await runOnce(over, null);
    await wake(over);
    await wake(fine);
    const got = claimed(await claim(5));
    expect(got.map((w) => w.agent.id)).toEqual([fine]);
    expect((await pool.query("select status from agent_wakes where agent_id = $1 and status = 'queued'", [over])).rowCount).toBe(1);
  });

  it('a run cap: the 4th of 5 warns, the 5th pauses; a claim of several wakes may not walk past the cap in one step', async () => {
    const agent = await mkAgent('Cap', { runs: 5 });
    for (let i = 0; i < 3; i++) await runOnce(agent, null);
    expect(await notes('agent_budget_warning', agent)).toBe(0);
    await runOnce(agent, null); // 4 of 5 = 80%: the warning fires when that run STARTS
    expect(await notes('agent_budget_warning', agent)).toBe(1);

    // Four wakes wait for this agent (each about its own ticket, so they do not merge) and the Runner asks for 5 at once: only the one run
    // the agent has left is given out, never all four.
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent]);
    for (let i = 0; i < 4; i++) {
      const t = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: `Cap ticket ${i}` } })).json().id as string;
      expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: t })).statusCode).toBe(201);
    }
    expect((await pool.query("select 1 from agent_wakes where agent_id = $1 and status = 'queued'", [agent])).rowCount).toBe(4);
    const diag = JSON.stringify({ gate: [...(await app.get(AgentBudgetService).claimGate(ws, [agent], new Date())).runsLeft], status: (await budget(agent)).runs });
    const got = claimed(await claim(5));
    expect(got, `agents claimed: ${got.map((w) => w.agent.id === agent ? 'cap' : w.agent.id)}; before: ${diag}`).toHaveLength(1);
    expect((await complete(got[0]!)).statusCode).toBe(200);
    expect(await notes('agent_budget_paused', agent)).toBe(1);
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect((await budget(agent))).toMatchObject({ state: 'paused', paused_reason: 'runs', runs: { limit: 5, used: 5, percent: 100 } });
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    expect(await waitingState(agent)).toMatchObject({ state: 'waiting_for_budget', budget_metric: 'runs' });
  });

  it('a single run that jumps from 50% past 100% sends ONE notice (paused), never the 80% one after it', async () => {
    const agent = await mkAgent('Jump', { tokens: 1000 });
    await runOnce(agent, 500);
    await runOnce(agent, 900);
    expect(await notes('agent_budget_paused', agent)).toBe(1);
    expect(await notes('agent_budget_warning', agent)).toBe(0);
    // The silent 80% record means that notice cannot arrive later for this limit either: it exists, and is marked sent.
    const rows = (await pool.query('select level from agent_budget_notices where agent_id = $1 order by level', [agent])).rows.map((r: { level: string }) => r.level);
    expect(rows).toEqual(['paused', 'warning']);
  });
});

describe('AC3: raising the budget resumes the agent; so does the month resetting', () => {
  it('raising the token budget resumes it on the next claim, and 80% of the NEW budget is news again', async () => {
    const agent = await mkAgent('Raise', { tokens: 1000 });
    await runOnce(agent, 1000);
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);

    expect((await setBudget(agent, { monthly_token_budget: 2000 })).statusCode).toBe(200);
    expect((await budget(agent)).state).toBe('ok');
    const got = claimed(await claim());
    expect(got).toHaveLength(1);
    expect((await complete(got[0]!, { usage: { tokens_in: 300, tokens_out: 300 } })).statusCode).toBe(200); // 1600 of 2000 = 80%
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect(await notes('agent_budget_paused', agent)).toBe(1);
  });

  it('clearing the budget resumes it too (no limit), and raising the run cap resumes a run-capped agent', async () => {
    const agent = await mkAgent('Clear', { runs: 1 });
    await runOnce(agent, null);
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    expect((await setBudget(agent, { monthly_run_cap: 2 })).statusCode).toBe(200);
    const got = claimed(await claim());
    expect(got).toHaveLength(1);
    expect((await complete(got[0]!)).statusCode).toBe(200);
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    expect((await setBudget(agent, { monthly_run_cap: null })).statusCode).toBe(200);
    expect(claimed(await claim())).toHaveLength(1);
  });

  it('the month rolling over resumes it with nothing to clear: last month\'s runs no longer count', async () => {
    const agent = await mkAgent('Reset', { tokens: 1000 });
    await runOnce(agent, 1000);
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    await pool.query(
      `update records set created_at = created_at - interval '40 days' where database_id = $1 and id in (select from_record_id from record_links l join relations r on r.id = l.relation_id where l.to_record_id = $2)`,
      [runsDbId, agent],
    );
    expect((await budget(agent)).state).toBe('ok');
    expect((await budget(agent)).runs.used).toBe(0);
    expect(claimed(await claim())).toHaveLength(1);
  });
});

describe('tokens a tool did not report are never counted as zero', () => {
  it('runs that finished without usage: tokens.used is null and says how many, the token budget cannot pause on a number nobody measured, and the run cap still holds', async () => {
    const agent = await mkAgent('Unmeasured', { tokens: 100, runs: 3 });
    await runOnce(agent, null);
    await runOnce(agent, null);
    const b = await budget(agent);
    expect(b.tokens).toMatchObject({ used: null, percent: null, state: 'not_measured', measurement: 'not_reported', unmeasured_runs: 2 });
    expect(b.state).toBe('ok');
    await runOnce(agent, null);
    expect(await budget(agent)).toMatchObject({ state: 'paused', paused_reason: 'runs' });
    expect(await notes('agent_budget_paused', agent)).toBe(1);
  });

  it('mixed: the total is the runs that reported, labelled partial, and warns on that lower bound', async () => {
    const agent = await mkAgent('Mixed', { tokens: 1000 });
    await runOnce(agent, 850);
    await runOnce(agent, null);
    const b = await budget(agent);
    expect(b.tokens).toMatchObject({ used: 850, measurement: 'partial', unmeasured_runs: 1, state: 'warning' });
    const sentence = (await pool.query("select snippet from notifications where type = 'agent_budget_warning' and record_id = $1", [agent])).rows[0].snippet as string;
    expect(sentence).toMatch(/850/);
  });
});

describe('who may set a budget', () => {
  it('a person who may edit the Agents database sets and clears it; whole numbers from 1 only, refused with a sentence and nothing stored', async () => {
    const agent = await mkAgent('Validation');
    for (const [value, re] of [[0, /at least 1/], [-3, /at least 1/], [2.5, /whole number/], ['lots', /whole number/], [1e15, /too large/]] as const) {
      const res = await setBudget(agent, { monthly_token_budget: value });
      expect(res.statusCode, `${String(value)}: ${res.body}`).toBe(422);
      expect(res.body).toMatch(re);
    }
    expect((await budget(agent)).limits.tokens).toBeNull();
    expect((await setBudget(agent, { monthly_token_budget: 5000, monthly_run_cap: 12 })).statusCode).toBe(200);
    expect((await budget(agent)).limits).toEqual({ tokens: 5000, runs: 12 });
    expect((await setBudget(agent, { monthly_token_budget: null, monthly_run_cap: null })).statusCode).toBe(200);
    expect((await budget(agent)).limits).toEqual({ tokens: null, runs: null });
  });

  it('the agent itself cannot raise or clear its own budget with the run credential it is handed', async () => {
    const agent = await mkAgent('Self', { tokens: 1000, runs: 5 });
    await wake(agent);
    const got = claimed(await claim());
    expect(got).toHaveLength(1);
    const cred = got[0]!.credential.token;
    for (const values of [{ monthly_token_budget: 999999 }, { monthly_run_cap: null }, { monthly_token_budget: null }]) {
      const res = await as(cred, 'PATCH', `/workspaces/${ws}/databases/${agentsDbId}/records/${agent}`, { values });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toMatch(/budget/);
    }
    expect((await budget(agent)).limits).toEqual({ tokens: 1000, runs: 5 });
  });
});

describe('the one-click catch-up honours the budget (the hook ticket #1152 left)', () => {
  it('allowance: unlimited with no run cap, the runs left under one, and 0 once paused (by either budget)', async () => {
    const budgets = app.get(AgentBudgetService);
    const none = await mkAgent('Allow none');
    expect(await budgets.catchUpAllowance(ws, none)).toBeNull();
    const capped = await mkAgent('Allow capped', { runs: 3 });
    await runOnce(capped, null);
    expect(await budgets.catchUpAllowance(ws, capped)).toBe(2);
    await runOnce(capped, null);
    await runOnce(capped, null);
    expect(await budgets.catchUpAllowance(ws, capped)).toBe(0);
    const tokens = await mkAgent('Allow tokens', { tokens: 100 });
    expect(await budgets.catchUpAllowance(ws, tokens)).toBeNull(); // a token budget cannot be turned into a number of wakes
    await runOnce(tokens, 100);
    expect(await budgets.catchUpAllowance(ws, tokens)).toBe(0);
  });

  it('the click itself answers queued 0 for a paused agent', async () => {
    const agent = await mkAgent('Catch paused', { runs: 1 });
    await runOnce(agent, null);
    const res = await as(owner.token, 'POST', `/workspaces/${ws}/agents/${agent}/catch-up`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().queued).toBe(0);
  });
});

// ---- AI-field usage caused by an agent counts toward that agent's budget (Otto, 2026-11-03, from ticket #1179) ----------------------
describe('AI-field usage caused by an agent counts toward its budget', () => {
  let aiDb = '';
  let noteApi = '';
  type Completion = { text: string; tokensIn: number; tokensOut: number; usageReported?: boolean };
  let reply: () => Completion = () => ({ text: 'summary', tokensIn: 300, tokensOut: 200, usageReported: true });

  const waitFor = async <T,>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> => {
    for (let i = 0; i < 80; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  beforeAll(async () => {
    app.get(AiFieldSubscriber).client = { complete: async () => reply() };
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    aiDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'AI leads' })).json().id;
    noteApi = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${aiDb}/fields`, { display_name: 'Note', type: 'text', config: {} })).json().apiName;
    const ai = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${aiDb}/fields`, { display_name: 'Summary', type: 'ai', config: { prompt: 'Summarize {Note}', output: { kind: 'text' } } });
    expect(ai.statusCode, ai.body).toBe(201);
  });

  /** Writes a record as `token` and runs the AI-field job it causes. */
  async function recompute(token: string) {
    const rec = (await as(token, 'POST', `/workspaces/${ws}/databases/${aiDb}/records`, { values: { name: 'Lead', [noteApi]: 'big deal' } })).json().id as string;
    await waitFor(async () => (await pool.query("select 1 from automation_jobs where kind = 'ai_field_recompute' and status = 'queued' and payload->>'recordId' = $1", [rec])).rows[0], 'the recompute job');
    await app.get(JobRunnerService).tick();
    return rec;
  }
  /** A claimed wake for the agent: the run credential is the real thing a Runner is handed. */
  async function startedRun(agent: string): Promise<Claimed> {
    await wake(agent);
    const got = claimed(await claim());
    expect(got).toHaveLength(1);
    return got[0]!;
  }

  it('tokens the AI field used for this agent are in tokens.used beside the run\'s own, counted from the recorded usage', async () => {
    reply = () => ({ text: 'summary', tokensIn: 300, tokensOut: 200, usageReported: true });
    const agent = await mkAgent('AI field counted', { tokens: 10_000 });
    const w = await startedRun(agent);
    await recompute(w.credential.token);
    let b = await budget(agent);
    expect(b.tokens).toMatchObject({ used: 500, ai_field: { tokens: 500, calls: 1, unmeasured_calls: 0 } });
    expect((await complete(w, { usage: { tokens_in: 100, tokens_out: 50 } })).statusCode).toBe(200);
    b = await budget(agent);
    expect(b.tokens).toMatchObject({ used: 650, measurement: 'full', ai_field: { tokens: 500, calls: 1 } });
  });

  it('it is attributed by the agent on the log row: a person\'s write and ANOTHER agent\'s write are not this agent\'s usage', async () => {
    reply = () => ({ text: 'summary', tokensIn: 400, tokensOut: 0, usageReported: true });
    const mine = await mkAgent('AI mine', { tokens: 10_000 });
    const other = await mkAgent('AI other', { tokens: 10_000 });
    const w = await startedRun(mine);
    await recompute(admin.token); // a person
    expect((await budget(mine)).tokens.ai_field).toMatchObject({ tokens: 0, calls: 0 });
    await recompute(w.credential.token);
    expect((await budget(mine)).tokens.ai_field).toMatchObject({ tokens: 400, calls: 1 });
    expect((await budget(other)).tokens.ai_field).toMatchObject({ tokens: 0, calls: 0 });
  });

  it('the pause holds for it: AI-field tokens alone take the agent to 80% (one notice), then 100% (one notice, claim refused)', async () => {
    reply = () => ({ text: 'summary', tokensIn: 400, tokensOut: 400, usageReported: true });
    const agent = await mkAgent('AI pause', { tokens: 1000 });
    const w = await startedRun(agent);
    await recompute(w.credential.token); // 800 of 1000
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect((await budget(agent)).state).toBe('warning');
    reply = () => ({ text: 'summary', tokensIn: 100, tokensOut: 100, usageReported: true });
    await recompute(w.credential.token); // 1000
    expect(await notes('agent_budget_paused', agent)).toBe(1);
    expect(await notes('agent_budget_warning', agent)).toBe(1);
    expect(await budget(agent)).toMatchObject({ state: 'paused', paused_reason: 'tokens', tokens: { used: 1000 } });
    // the run in flight finishes (a pause stops NEW claims); the next wake is not given out
    expect((await complete(w)).statusCode).toBe(200);
    await wake(agent);
    expect(claimed(await claim())).toHaveLength(0);
    expect(await waitingState(agent)).toMatchObject({ state: 'waiting_for_budget', budget_metric: 'tokens' });
  });

  it('usage the model did not report is NOT counted as 0: null, labelled, never a pause on a number nobody measured', async () => {
    reply = () => ({ text: 'summary', tokensIn: 999_999, tokensOut: 999_999 }); // no usageReported: like a vendor that sent no usage
    const agent = await mkAgent('AI unreported', { tokens: 100 });
    const w = await startedRun(agent);
    await recompute(w.credential.token);
    expect((await complete(w)).statusCode).toBe(200);
    const b = await budget(agent);
    expect(b.tokens).toMatchObject({ used: null, state: 'not_measured', measurement: 'not_reported', ai_field: { tokens: null, calls: 1, unmeasured_calls: 1 } });
    expect(b.state).toBe('ok');
  });

  it('mixed: a run that reported plus an AI call that did not is a partial total, "at least"', async () => {
    reply = () => ({ text: 'summary', tokensIn: 1, tokensOut: 1 });
    const agent = await mkAgent('AI mixed', { tokens: 1000 });
    const w = await startedRun(agent);
    await recompute(w.credential.token);
    expect((await complete(w, { usage: { tokens_in: 500, tokens_out: 300 } })).statusCode).toBe(200);
    expect((await budget(agent)).tokens).toMatchObject({ used: 800, measurement: 'partial', unmeasured_runs: 0, ai_field: { tokens: null, calls: 1, unmeasured_calls: 1 }, state: 'warning' });
  });

  it('a call that FAILED is neither counted nor called unmeasured', async () => {
    reply = () => {
      throw new Error('vendor down');
    };
    const agent = await mkAgent('AI failed', { tokens: 1000 });
    const w = await startedRun(agent);
    await recompute(w.credential.token).catch(() => undefined);
    expect((await complete(w)).statusCode).toBe(200);
    expect((await budget(agent)).tokens).toMatchObject({ ai_field: { calls: 0, unmeasured_calls: 0 } });
  });

  it('last month\'s AI-field usage does not count', async () => {
    reply = () => ({ text: 'summary', tokensIn: 300, tokensOut: 200, usageReported: true });
    const agent = await mkAgent('AI month', { tokens: 1000 });
    const w = await startedRun(agent);
    await recompute(w.credential.token);
    await pool.query("update activity_events set created_at = created_at - interval '40 days' where type = 'outward.ai_field' and agent_id = $1", [agent]);
    expect((await budget(agent)).tokens.ai_field).toMatchObject({ tokens: 0, calls: 0 });
  });
});

describe('a notice always reaches someone', () => {
  const aiEvent = (agent: string) =>
    pool.query("insert into activity_events (workspace_id, type, payload, source, agent_id) values ($1, 'outward.ai_field', $2::jsonb, 'agent', $3)", [
      ws,
      JSON.stringify({ object: { kind: 'record', id: agent, name: 'x' }, channel: 'ai_field', summary: 's', usage: { tokens_in: 450, tokens_out: 450 } }),
      agent,
    ]);

  it('if the agent\'s creator is gone (null), the manager notice goes to a workspace admin, once, instead of being recorded as sent to nobody', async () => {
    const agent = await mkAgent('Orphan', { tokens: 1000 });
    await pool.query('update records set created_by = null where id = $1', [agent]);
    await aiEvent(agent);
    const adminId = (await as(admin.token, 'GET', '/me')).json().id as string;
    const budgets = app.get(AgentBudgetService);
    await budgets.afterUsageChange(ws, agent);
    await budgets.afterUsageChange(ws, agent);
    const sent = (await pool.query("select user_id, coalesce(sum(count),0)::int n from notifications where type = 'agent_budget_warning' and record_id = $1 group by user_id", [agent])).rows;
    expect(sent).toEqual([{ user_id: adminId, n: 1 }]);
  });

  it('if nobody at all can be told, the notice is NOT recorded as sent, so a later change can still send it', async () => {
    const agent = await mkAgent('Nobody', { tokens: 1000 });
    await pool.query('update records set created_by = null where id = $1', [agent]);
    await aiEvent(agent);
    await pool.query("update memberships set status = 'pending' where workspace_id = $1 and role = 'admin'", [ws]);
    try {
      await app.get(AgentBudgetService).afterUsageChange(ws, agent);
      expect((await pool.query('select 1 from agent_budget_notices where agent_id = $1', [agent])).rowCount).toBe(0);
    } finally {
      await pool.query("update memberships set status = 'active' where workspace_id = $1 and role = 'admin'", [ws]);
    }
    await app.get(AgentBudgetService).afterUsageChange(ws, agent);
    expect((await pool.query('select 1 from agent_budget_notices where agent_id = $1', [agent])).rowCount).toBeGreaterThan(0);
  });
});
