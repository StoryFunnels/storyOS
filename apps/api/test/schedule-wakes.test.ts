import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { automations } from '../src/db/schema';

/**
 * #1175 / ADR-0021 §1 — a scheduled rule wakes a `Your own AI` agent ONCE per firing, with no record, however many records the rule
 * selects, however many times the tick runs for that slot (twice, on two replicas at once, a job retried after a crash), and a
 * different slot is a different firing. Real fixtures: the scheduler's own tick, the job runner, the wake rows themselves.
 */
const { db: rawDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string, contentDb: string, agentsDb: string;
let aiModeIds: Record<string, string> = {};
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const automationsSvc = () => app.get(AutomationsService);
const jobs = () => app.get(JobRunnerService);

async function mkAgent(name: string, aiMode: string | null, enabled = true): Promise<string> {
  const res = await as('POST', `/workspaces/${ws}/databases/${agentsDb}/records`, {
    values: { name, enabled, ...(aiMode ? { ai_mode: aiModeIds[aiMode] } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mkRecords(db: string, n: number, prefix: string) {
  for (let i = 0; i < n; i++) {
    const r = await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: `${prefix} ${i}` } });
    expect(r.statusCode, r.body).toBe(201);
  }
}
async function mkRule(db: string, agent: string, trigger: unknown = { type: 'schedule', every: 'day', at: '03:00' }) {
  const rule = await as('POST', `/workspaces/${ws}/databases/${db}/automations`, {
    name: `Rule ${Math.random().toString(36).slice(2, 7)}`,
    trigger,
    actions: [{ type: 'run_agent', agent, target: 'trigger_record' }],
  });
  expect(rule.statusCode, rule.body).toBe(201);
  return rule.json().id as string;
}
const dueAt = async (ruleId: string, at: Date) => { await rawDb.update(automations).set({ nextDueAt: at }).where(eq(automations.id, ruleId)); };
const slotOf = async (ruleId: string) => (await rawDb.query.automations.findFirst({ where: eq(automations.id, ruleId) }))!.nextDueAt!;
const wakeRows = async (agent: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agent])).rows;
const runsOf = async (ruleId: string) => Number((await pool.query('select count(*)::int as n from automation_runs where automation_id = $1', [ruleId])).rows[0].n);
async function drain() { for (let i = 0; i < 6; i++) await jobs().tick(); }

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Schedule Wakes');
  ws = (await as('POST', '/workspaces', { name: 'Schedule Wakes WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDb = ensured.agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDb]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  contentDb = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tickets' })).json().id;
  await mkRecords(contentDb, 9, 'Ticket');
}, 240_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('#1175 a schedule firing wakes a Your-own-AI agent once, with no record', () => {
  it('one firing over 9 records is ONE wake (no record, reason automation, no Runner needed), not nine', async () => {
    const agent = await mkAgent('Night owl', 'Your own AI');
    const rule = await mkRule(contentDb, agent);
    await dueAt(rule, new Date(Date.now() - 1000));
    await automationsSvc().tick();
    await drain();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'automation', record_id: null, database_id: null, coalesced_count: 0 }); // the other 8 jobs are replays of the same firing, not repeats
    expect(rows[0].source_key).toMatch(new RegExp(`^schedule:${rule}:0:`));
    expect(await runsOf(rule)).toBe(9); // the rule still ran for each selected record; only the wake is one
  });

  it('a second tick, and a replay of the SAME slot after a crash, add no wake', async () => {
    const agent = await mkAgent('Replay owl', 'Your own AI');
    const rule = await mkRule(contentDb, agent);
    const slot = new Date(Date.now() - 5000);
    await dueAt(rule, slot);
    await automationsSvc().tick();
    await drain();
    await automationsSvc().tick(); // nothing is due any more
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
    expect(await runsOf(rule)).toBe(9);
    // the crash-retry: the slot is re-offered (the bookkeeping write was lost), every job runs again with fresh job ids
    await dueAt(rule, slot);
    await automationsSvc().tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
    // ...even when the wake has been served by then: the slot's key remembers it, so it is not woken again for the same firing
    await pool.query("update agent_wakes set status = 'done', finished_at = now() where agent_id = $1", [agent]);
    await dueAt(rule, slot);
    await automationsSvc().tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
  });

  it('two ticks at once (two replicas) fire the slot once: one wake and one set of rule runs', async () => {
    const agent = await mkAgent('Parallel owl', 'Your own AI');
    const rule = await mkRule(contentDb, agent);
    await dueAt(rule, new Date(Date.now() - 1000));
    await Promise.all([automationsSvc().tick(), automationsSvc().tick()]);
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
    expect(await runsOf(rule)).toBe(9);
  });

  it('the next firing is a new slot: it coalesces into a wake still queued, and is a NEW wake once that one is done', async () => {
    const agent = await mkAgent('Daily owl', 'Your own AI');
    const rule = await mkRule(contentDb, agent);
    await dueAt(rule, new Date(Date.now() - 2 * 86_400_000));
    await automationsSvc().tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
    // tomorrow's firing while yesterday's wake is still waiting: ADR-0021 §1, one open record-less wake per agent
    await dueAt(rule, new Date(Date.now() - 86_400_000));
    await automationsSvc().tick();
    await drain();
    let rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].coalesced_count, JSON.stringify([rows[0].reasons, await runsOf(rule)])).toBeGreaterThan(0);
    // once it is done, the next firing wakes the agent afresh
    await pool.query("update agent_wakes set status = 'done', finished_at = now() where agent_id = $1", [agent]);
    await dueAt(rule, new Date(Date.now() - 1000));
    await automationsSvc().tick();
    await drain();
    rows = await wakeRows(agent);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: { status: string }) => r.status === 'queued')).toHaveLength(1);
  });

  it('a disabled agent gets no wake; the firing is a failed job, not a queue entry', async () => {
    const agent = await mkAgent('Sleeping owl', 'Your own AI', false);
    const rule = await mkRule(contentDb, agent);
    await dueAt(rule, new Date(Date.now() - 1000));
    await automationsSvc().tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(0);
  });

  it('MUST KEEP: a record-triggered run_agent rule still wakes once per agent AND record', async () => {
    const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Inbox' })).json().id as string;
    const agent = await mkAgent('Inbox owl', 'Your own AI');
    await mkRule(db, agent, { type: 'record_created' });
    await mkRecords(db, 3, 'Mail');
    for (let i = 0; i < 3; i++) await automationsSvc().settleAll?.();
    await drain();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r: { record_id: string }) => r.record_id)).size).toBe(3);
  });

  it('MUST KEEP: a scheduled rule over a NON-own-AI agent still runs once per record', async () => {
    const agent = await mkAgent('Plain bot', null);
    const plainRuns = async () => Number((await pool.query("select count(*)::int as n from records r join databases d on d.id = r.database_id where d.system_key = 'agent_runs' and r.title like 'Plain bot%' and d.workspace_id = $1", [ws])).rows[0].n);
    const before = await plainRuns();
    const rule = await mkRule(contentDb, agent);
    await dueAt(rule, new Date(Date.now() - 1000));
    await automationsSvc().tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(0);
    expect((await plainRuns()) - before).toBe(9);
  });
});
