import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema, type PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { automations } from '../src/db/schema';

/**
 * Ticket #1198 — a pack can schedule its OWN agent ("Deal Coach reviews the pipeline every Monday").
 *
 * A manifest cannot know the id an agent will get, so a rule's `run_agent` action names the pack's own agent by ref
 * (`$agent:deal-coach`) and install resolves it. The schedule is #1194's own trigger shape, the rule installs OFF (#1107/#1192: nothing
 * wakes an agent until a person switches it on in the review), and a scheduled firing is ONE wake (#1175). Real fixtures: the scheduler's
 * own tick, the job runner, the wake rows themselves; every built-in pack is not needed, only a manifest with one agent and one rule.
 */
const { db: rawDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Agent Schedule');
}, 90_000);
afterAll(async () => { await app?.close(); await pool.end(); });

const COACH = 'Deal Coach';
const RULE = 'Monday pipeline review';
const LABEL = `Tickets.${RULE}`;
const MONDAY = { type: 'schedule', every: 'week', weekday: 1, at: '09:00', timezone: 'Europe/Berlin' };

const coach = () => ({ name: COACH, goal: 'Review the pipeline', scopes: ['read'], approval_policy: [], target_databases: ['Tickets'], ai_mode: 'your_own_ai' });
const rule = (over: Record<string, unknown> = {}) => ({
  database: 'Tickets',
  name: RULE,
  trigger: MONDAY,
  actions: [{ type: 'run_agent', agent: '$agent:deal-coach', target: 'trigger_record' }],
  enabled: true,
  ...over,
});
/** Support Inbox (it has a Tickets database and no run_agent rule) plus the pack's own Deal Coach and its scheduled review. */
function manifestWith(slug: string, o: { agents?: Array<Record<string, unknown>>; rule?: Record<string, unknown> } = {}): PackManifest {
  const m = structuredClone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as PackManifest;
  m.slug = slug;
  m.agents = [...m.agents, ...(o.agents ?? [coach()])] as never;
  m.automations = [...m.automations, o.rule ?? rule()] as never;
  return m;
}

const newWs = async () => (await as('POST', '/workspaces', { name: `Pack agent schedule ${Date.now()}${Math.random()}` })).json().id as string;
const installRaw = (ws: string, m: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, ...extra });
async function install(ws: string, m: unknown, extra: Record<string, unknown> = {}) {
  const res = await installRaw(ws, m, extra);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as {
    agents: Array<{ name: string; action: string; id: string }>;
    automations: Array<{ name: string; action: string; id: string; enabled?: boolean; switched_off_because?: string }>;
  };
}
async function ticketsDb(ws: string) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  return dbs.find((d) => d.name === 'Tickets')!.id;
}
type Live = { id: string; name: string; enabled: boolean; trigger: Record<string, unknown>; actions: Array<Record<string, unknown>> };
const liveRules = async (ws: string) => (await as('GET', `/workspaces/${ws}/databases/${await ticketsDb(ws)}/automations`)).json().data as Live[];
const liveRule = async (ws: string) => (await liveRules(ws)).find((r) => r.name === RULE)!;
async function uninstall(ws: string, slug: string) {
  const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
  const res = await as('POST', `/workspaces/${ws}/packs/${list.find((i) => i.slug === slug)!.id}/uninstall`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason?: string }> };
}
const wakeRows = async (agent: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agent])).rows;
async function drain() { for (let i = 0; i < 8; i++) await app.get(JobRunnerService).tick(); }

describe('#1198 AC1: a manifest\'s scheduled agent installs with the right agent id, switched off', () => {
  it('the rule runs the agent INSTALL created (its id, not a ref), keeps the #1194 schedule, and is OFF with the reason "agent"', async () => {
    const ws = await newWs();
    const out = await install(ws, manifestWith('sched-agent-install'));
    const agent = out.agents.find((a) => a.name === COACH)!;
    expect(agent.action).toBe('created');
    const created = out.automations.find((a) => a.name === LABEL)!;
    expect(created).toMatchObject({ action: 'created', enabled: false, switched_off_because: 'agent' });
    const live = await liveRule(ws);
    expect(live.enabled).toBe(false);
    expect(live.actions[0]).toMatchObject({ type: 'run_agent', agent: agent.id, target: 'trigger_record' });
    expect(live.trigger).toMatchObject(MONDAY);
  }, 90_000);

  it('the preview lists the rule as off because it runs an agent, and a person can switch it on in the review (enable_automations)', async () => {
    const ws = await newWs();
    const m = manifestWith('sched-agent-preview');
    const prev = (await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m })).json();
    expect(prev.automations.find((a: { name: string }) => a.name === LABEL)).toMatchObject({ enabled_on_install: false, switched_off_because: 'agent' });
    const on = (await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m, enable_automations: [LABEL] })).json();
    expect(on.automations.find((a: { name: string }) => a.name === LABEL)).toMatchObject({ enabled_on_install: true });
    const out = await install(ws, m, { enable_automations: [LABEL] });
    expect(out.automations.find((a) => a.name === LABEL)?.enabled).toBe(true);
    expect((await liveRule(ws)).enabled).toBe(true);
  }, 90_000);

  it('MUST KEEP: a scheduled rule that runs no agent is unaffected, and an existing record-event run_agent-free manifest still installs', async () => {
    const ws = await newWs();
    const plain = rule({ name: 'Plain schedule', actions: [{ type: 'add_comment', body_template: 'Weekly' }] });
    const out = await install(ws, manifestWith('sched-agent-plain', { agents: [], rule: plain }));
    expect(out.automations.find((a) => a.name === 'Tickets.Plain schedule')).toMatchObject({ action: 'created', enabled: true });
  }, 90_000);
});

describe('#1198 AC2: switched on in the review, it fires on schedule as one wake', () => {
  it('a due slot wakes the pack\'s agent ONCE (no record), a second tick and a replay of the same slot add none', async () => {
    const ws = await newWs();
    const out = await install(ws, manifestWith('sched-agent-fires'), { enable_automations: [LABEL] });
    const agent = out.agents.find((a) => a.name === COACH)!.id;
    const ruleId = (await liveRule(ws)).id;
    const slot = new Date(Date.now() - 5000); // the fake clock: the slot is made due in the past, the scheduler's own tick picks it up
    await rawDb.update(automations).set({ nextDueAt: slot }).where(eq(automations.id, ruleId));
    await app.get(AutomationsService).tick();
    await drain();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'automation', record_id: null });
    expect(rows[0].source_key).toMatch(new RegExp(`^schedule:${ruleId}:0:`));

    await app.get(AutomationsService).tick(); // nothing due any more
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
    await rawDb.update(automations).set({ nextDueAt: slot }).where(eq(automations.id, ruleId)); // the crash-retry of the SAME slot
    await app.get(AutomationsService).tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);

    // the next slot while this wake is still queued coalesces into it (ADR-0021 §1): schedule-wakes.test.ts owns that rule.
  }, 120_000);

  it('left OFF (the default), the same due slot wakes nothing', async () => {
    const ws = await newWs();
    const out = await install(ws, manifestWith('sched-agent-off'));
    const agent = out.agents.find((a) => a.name === COACH)!.id;
    const ruleId = (await liveRule(ws)).id;
    await rawDb.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, ruleId));
    await app.get(AutomationsService).tick();
    await drain();
    expect(await wakeRows(agent)).toHaveLength(0);
  }, 90_000);
});

describe('#1198 AC3: an unknown manifest key fails the install validation with a clear error', () => {
  it('a rule naming an agent the manifest does not declare is a 422 that names the rule, the ref and the agents the pack does declare; nothing is installed', async () => {
    const ws = await newWs();
    const bad = rule({ actions: [{ type: 'run_agent', agent: '$agent:deal-closer' }] });
    const res = await installRaw(ws, manifestWith('sched-agent-unknown', { rule: bad }));
    expect(res.statusCode, res.body).toBe(422);
    const msg = res.json().error.message as string;
    expect(msg).toContain(LABEL);
    expect(msg).toContain('$agent:deal-closer');
    expect(msg).toContain('"Deal Coach" ($agent:deal-coach)');
    expect(await ticketsDb(ws).catch(() => undefined)).toBeUndefined(); // nothing was built
  }, 90_000);

  it('the preview refuses it the same way, and a pack with NO agents says so', async () => {
    const ws = await newWs();
    const m = manifestWith('sched-agent-unknown-prev', { agents: [], rule: rule() });
    m.agents = [];
    m.triggers = [];
    const res = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toContain('declares no agents');
  }, 90_000);

  it('two agents whose names make the same ref are refused as ambiguous, not resolved to one of them', async () => {
    const ws = await newWs();
    const twin = { ...coach(), name: 'Deal-Coach' };
    const res = await installRaw(ws, manifestWith('sched-agent-twins', { agents: [coach(), twin] }));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toContain('more than one agent');
  }, 90_000);

  it('a bad cadence is refused up front with the rule engine\'s own reason (#1194 schedule), not halfway through the install', async () => {
    const ws = await newWs();
    const tooFast = rule({ trigger: { type: 'schedule', every: 'minutes', minutes: 5 } });
    const a = await installRaw(ws, manifestWith('sched-agent-fast', { rule: tooFast }));
    expect(a.statusCode, a.body).toBe(422);
    expect(a.json().error.message).toContain(LABEL);
    expect(a.json().error.message).toMatch(/10/);
    const unknownEvery = rule({ trigger: { type: 'schedule', every: 'fortnight' } });
    const b = await installRaw(ws, manifestWith('sched-agent-fortnight', { rule: unknownEvery }));
    expect(b.statusCode, b.body).toBe(422);
    const badZone = rule({ trigger: { ...MONDAY, timezone: 'Mars/Olympus' } });
    const c = await installRaw(ws, manifestWith('sched-agent-zone', { rule: badZone }));
    expect(c.statusCode, c.body).toBe(422);
    expect(await ticketsDb(ws).catch(() => undefined)).toBeUndefined();
  }, 90_000);

  it('a ref in an ordinary manifest is still just text elsewhere: an automation with no $agent ref installs exactly as before', () => {
    expect(packManifestSchema.safeParse(manifestWith('sched-agent-schema')).success).toBe(true);
  });
});

describe('#1198 round trip, uninstall, and the person\'s choices', () => {
  it('export carries the agent (no state trigger binds it) and the rule by $agent: ref, never an id; re-installing it elsewhere schedules the NEW agent', async () => {
    const src = await newWs();
    const first = await install(src, manifestWith('sched-agent-export-src'));
    const res = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'sched-agent-export-out', name: 'Sched out', why: 'Probe', can: ['Probe'], database_ids: [await ticketsDb(src)] });
    expect(res.statusCode, res.body).toBe(201);
    const out = (res.json().manifest ?? res.json()) as PackManifest;
    expect(out.agents.map((a) => a.name)).toContain(COACH);
    const exported = out.automations.find((a) => a.name === RULE)!;
    expect(exported.actions[0]).toMatchObject({ type: 'run_agent', agent: '$agent:deal-coach' });
    expect(exported.trigger).toMatchObject(MONDAY);
    expect(JSON.stringify(out)).not.toContain(first.agents.find((a) => a.name === COACH)!.id);

    const dst = await newWs();
    const again = await install(dst, { ...out, slug: 'sched-agent-export-again' });
    const agentId = again.agents.find((a) => a.name === COACH)!.id;
    expect(agentId).not.toBe(first.agents.find((a) => a.name === COACH)!.id);
    expect((await liveRule(dst)).actions[0]).toMatchObject({ agent: agentId });
  }, 120_000);

  it('uninstall removes an untouched rule, and KEEPS one the person edited ("Changed since install.")', async () => {
    const clean = await newWs();
    await install(clean, manifestWith('sched-agent-clean'));
    const out = await uninstall(clean, 'sched-agent-clean');
    expect(out.removed.map((r) => r.name)).toContain(LABEL);
    expect(out.kept.filter((k) => k.kind === 'automation')).toEqual([]);

    const edited = await newWs();
    await install(edited, manifestWith('sched-agent-edited'));
    const patch = await as('PATCH', `/workspaces/${edited}/databases/${await ticketsDb(edited)}/automations/${(await liveRule(edited)).id}`, { trigger: { ...MONDAY, weekday: 2 } });
    expect(patch.statusCode, patch.body).toBe(200);
    const kept = await uninstall(edited, 'sched-agent-edited');
    expect(kept.kept.find((k) => k.name === LABEL)?.reason).toBe('Changed since install.');
  }, 120_000);

  it('a collision rename of the agent carries the rule with it; skipping the agent skips the rule, never a rule pointing at nothing', async () => {
    const preexisting = async () => {
      const ws = await newWs();
      const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
      const made = await as('POST', `/workspaces/${ws}/databases/${ensured.agentsDb.id}/records`, { values: { name: COACH, enabled: true } });
      expect(made.statusCode, made.body).toBe(201);
      return ws;
    };
    const renamedWs = await preexisting();
    const renamed = await install(renamedWs, manifestWith('sched-agent-rename'), { resolutions: { [COACH]: { action: 'rename', rename_to: 'Deal Coach Two' } } });
    const two = renamed.agents.find((a) => a.name === 'Deal Coach Two')!;
    expect(two.action).toBe('created');
    expect((await liveRule(renamedWs)).actions[0]).toMatchObject({ agent: two.id });

    const skippedWs = await preexisting();
    const skipped = await install(skippedWs, manifestWith('sched-agent-skip'), { resolutions: { [COACH]: { action: 'skip' } } });
    expect(skipped.automations.find((a) => a.name === LABEL)?.action).toBe('skipped');
    expect((await liveRules(skippedWs)).find((r) => r.name === RULE)).toBeUndefined();
  }, 180_000);
});
