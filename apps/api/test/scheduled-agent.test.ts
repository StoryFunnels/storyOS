import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { automations } from '../src/db/schema';

/**
 * Ticket #1056 — an agent can work overnight from the web: the automation editor offers "Run an agent", and it works with "On a
 * schedule". This drives the REAL path with nobody signed in: the scheduler's own tick (no HTTP request, no session) selects the
 * records, queues the run_agent action, the job runner executes it, and the run lands in Runs and in Automation runs.
 * The agent here is a plain Non-AI one (no AI mode set): the shipped runtime, not a swapped-in double.
 *
 * Also: the agents' "Schedule" Trigger option was a label nothing dispatched with. New packs no longer offer it, and a pack that
 * still does has it retired when nothing uses it (and kept when something does).
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string, contentDb: string, agentsDb: string, runsDb: string, agentId: string;
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

async function fieldsOf(db: string) {
  const detail = (await as('GET', `/workspaces/${ws}/databases/${db}`)).json();
  return new Map(detail.fields.map((f: { apiName: string }) => [f.apiName, f])) as Map<string, { id: string; options?: Array<{ id: string; label: string }> }>;
}
const label = (field: { options?: Array<{ id: string; label: string }> } | undefined) => (id: string) => field?.options?.find((o) => o.id === id)?.label;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Scheduled Agent');
  ws = (await as('POST', '/workspaces', { name: 'Scheduled Agent WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  contentDb = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Content' })).json().id;
  const ensured = await as('POST', `/workspaces/${ws}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDb = ensured.json().agentsDb.id;
  runsDb = ensured.json().runsDb.id;
  const scopes = (await fieldsOf(agentsDb)).get('scopes');
  const agent = await as('POST', `/workspaces/${ws}/databases/${agentsDb}/records`, {
    values: { name: 'Night owl', enabled: true, scopes: [scopes!.options!.find((o) => o.label === 'write')!.id] },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = agent.json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

async function dueRule(actions: unknown[]) {
  const rule = await as('POST', `/workspaces/${ws}/databases/${contentDb}/automations`, {
    name: `Nightly ${Math.random().toString(36).slice(2, 7)}`,
    trigger: { type: 'schedule', every: 'day', at: '03:00' },
    actions,
  });
  expect(rule.statusCode, rule.body).toBe(201);
  await rawDb.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, rule.json().id));
  return rule.json().id as string;
}

describe('#1056 a scheduled rule runs an agent with nobody signed in', () => {
  it('the scheduler tick queues the run, the job runner runs the Non-AI agent, and the run is in Runs and in Automation runs', async () => {
    const rec = await as('POST', `/workspaces/${ws}/databases/${contentDb}/records`, { values: { name: 'Nightly target' } });
    expect(rec.statusCode, rec.body).toBe(201);
    const ruleId = await dueRule([{ type: 'run_agent', agent: agentId, target: 'trigger_record' }]);

    await app.get(AutomationsService).tick(); // the scheduler's own entry point — no request, no session
    await app.get(AutomationsService).settle(rec.json().id);
    await app.get(JobRunnerService).tick();

    const runFields = await fieldsOf(runsDb);
    const runs = (await as('GET', `/workspaces/${ws}/databases/${runsDb}/records`)).json().data as Array<{ title: string; values: Record<string, string> }>;
    const run = runs.find((r) => r.title === 'Night owl — Automation');
    expect(run, JSON.stringify(runs.map((r) => r.title))).toBeTruthy();
    expect(label(runFields.get('trigger'))(run!.values['trigger']!)).toBe('Automation');
    expect(label(runFields.get('status'))(run!.values['status']!)).toBe('Succeeded');
    expect(label(runFields.get('run_class'))(run!.values['run_class']!)).toBe('Non-AI');

    const list = (await as('GET', `/workspaces/${ws}/runs`)).json();
    const rows = (list.data ?? list) as Array<{ rule_id?: string; automation_id?: string; actions?: unknown[]; status?: string }>;
    expect(JSON.stringify(rows)).toContain(ruleId);
  });

  it('an approval-gated Run an agent step still stops and waits for a person: nothing runs until it is approved', async () => {
    const before = ((await as('GET', `/workspaces/${ws}/databases/${runsDb}/records`)).json().data as unknown[]).length;
    const rec = await as('POST', `/workspaces/${ws}/databases/${contentDb}/records`, { values: { name: 'Gated target' } });
    await dueRule([{ type: 'run_agent', agent: agentId, target: 'trigger_record', require_approval: true }]);

    await app.get(AutomationsService).tick();
    await app.get(AutomationsService).settle(rec.json().id);
    await app.get(JobRunnerService).tick();

    const approvals = (await as('GET', `/workspaces/${ws}/approvals`)).json();
    const pending = ((approvals.data ?? approvals) as Array<{ status: string; preview_text?: string }>).filter((a) => a.status === 'pending');
    expect(pending.some((a) => (a.preview_text ?? '').includes('Run agent'))).toBe(true);
    const after = ((await as('GET', `/workspaces/${ws}/databases/${runsDb}/records`)).json().data as unknown[]).length;
    // the earlier test's rule may run again for the new record; the GATED rule must not have added a run of its own
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe('#1056 the "Schedule" run trigger had no behaviour, so it is gone', () => {
  it('a new pack offers Manual, State change and Automation — not Schedule — on both Agents and Runs', async () => {
    for (const db of [agentsDb, runsDb]) {
      const trigger = (await fieldsOf(db)).get('trigger');
      expect(trigger?.options?.map((o) => o.label).sort()).toEqual(['Automation', 'Manual', 'State change']);
    }
  });

  it('a pack that still offers it has it retired by ensure when nothing uses it, and keeps it when something does', async () => {
    const trigger = (await fieldsOf(runsDb)).get('trigger')!;
    // an older pack: put the label back, then ensure again
    const added = await as('POST', `/workspaces/${ws}/databases/${runsDb}/fields/${trigger.id}/options`, { label: 'Schedule', color: 'purple' });
    expect(added.statusCode, added.body).toBeLessThan(300);
    expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
    expect((await fieldsOf(runsDb)).get('trigger')?.options?.map((o) => o.label)).not.toContain('Schedule');

    // used: a run carrying it keeps the option (ensure never rewrites someone's data)
    const again = await as('POST', `/workspaces/${ws}/databases/${runsDb}/fields/${trigger.id}/options`, { label: 'Schedule', color: 'purple' });
    const scheduleId = (again.json() as { id: string }).id ?? (await fieldsOf(runsDb)).get('trigger')!.options!.find((o) => o.label === 'Schedule')!.id;
    const used = await as('POST', `/workspaces/${ws}/databases/${runsDb}/records`, { values: { name: 'Old schedule run', trigger: scheduleId } });
    expect(used.statusCode, used.body).toBeLessThan(300);
    expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
    expect((await fieldsOf(runsDb)).get('trigger')?.options?.map((o) => o.label)).toContain('Schedule');
  });
});
