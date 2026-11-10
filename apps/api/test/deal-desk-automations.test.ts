import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { createTestApp } from './helpers/app';
import { call } from './helpers/members';
import { signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { eq } from 'drizzle-orm';
import { AutomationsService } from '../src/automations/automations.service';
import { automations } from '../src/db/schema';

/**
 * ticket #1201 (PR 2 of 2) - Deal Desk: the automations and the three agents.
 *
 * What must hold: every rule and agent of the spec exists; a rule that leaves the workspace (Won -> Slack) and a rule that runs an agent
 * (Monday review) install OFF; every agent trigger installs OFF (#1192) and none is human-gated (#1212); a fresh install and an install over
 * Agency OS both work.
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'deal-desk')!;
const agencyOs = () => PACK_REGISTRY.find((p) => p.slug === 'agency-os')!.manifest;

const { db: rawDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const newWs = async (n: string) => (await as('POST', '/workspaces', { name: `${n} ${Date.now()}` })).json().id as string;
const install = (ws: string, body: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest, ...body });
const dbsOf = async (ws: string) => (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
type Live = { id: string; name: string; enabled: boolean; trigger: Record<string, unknown>; condition?: unknown; actions: Array<Record<string, unknown>>; sort?: unknown; limit?: number | null };
const liveRules = async (ws: string, db: string) => {
  const id = (await dbsOf(ws)).find((d) => d.name === db)!.id;
  return ((await as('GET', `/workspaces/${ws}/databases/${id}/automations`)).json().data ?? []) as Live[];
};

const SPEC_RULES = ['Stalled deal nudge', 'Lost needs a reason', 'Expire old quotes', 'Accepted quote moves the deal to Won', 'Won: tell Slack'];
const EXTRA_RULES = ['Stalled deals digest', 'Monday pipeline review'];
const AGENTS = ['Deal Coach', 'Call Debrief', 'Hand-off Writer'];

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Deal Desk Automations Owner');
}, 240_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('#1201 the manifest lists every automation and agent of the spec', () => {
  const m = entry.manifest;
  it('is still valid, with the 5 spec rules, the 2 scheduled-feature rules, 3 agents and 3 triggers', () => {
    expect(packManifestSchema.safeParse(m).success).toBe(true);
    expect(m.automations.map((a) => a.name)).toEqual([...SPEC_RULES, ...EXTRA_RULES]);
    expect(m.agents.map((a) => a.name)).toEqual(AGENTS);
    expect(m.triggers.map((t) => `${t.agent}:${t.database}.${t.state_field}=${t.state_option}`)).toEqual([
      'Deal Coach:Deals.Stage=Proposal', 'Call Debrief:Activities.Status=Logged', 'Hand-off Writer:Deals.Stage=Won',
    ]);
    expect(m.requires.ai).toBe('byo');
  });

  it('every agent asks before changing anything: write_gates on create+update with no database, outward actions gated, own AI, read+write', () => {
    for (const a of m.agents) {
      expect(a.write_gates, a.name).toEqual([{ operations: ['create', 'update'] }]);
      expect(a.approval_policy, a.name).toEqual(['delete', 'email', 'webhook', 'outward']);
      expect(a.ai_mode, a.name).toBe('your_own_ai');
      expect(a.scopes, a.name).toEqual(['read', 'write']);
    }
  });

  it('no trigger is human-gated (#1212): the human check is the install switch plus the write gate', () => {
    expect(m.triggers.every((t) => t.human_gate === false)).toBe(true);
  });

  it('the accepted-quote rule asks for approval; the digest carries sort + limit 5; the Monday review runs the pack\'s own Deal Coach', () => {
    const rule = (n: string) => m.automations.find((a) => a.name === n)!;
    expect(rule('Accepted quote moves the deal to Won').actions[0]).toMatchObject({ type: 'update_linked', require_approval: true });
    expect(rule('Stalled deals digest')).toMatchObject({ limit: 5, sort: [{ field: 'updated_at', direction: 'asc' }], trigger: { type: 'schedule', every: 'week', weekday: 1 } });
    expect(rule('Monday pipeline review').actions[0]).toMatchObject({ type: 'run_agent', agent: '$agent:deal-coach' });
    expect(rule('Won: tell Slack').actions[0]).toMatchObject({ type: 'send_slack_message' });
    expect((rule('Won: tell Slack').actions[0] as { channel?: string }).channel, 'no channel: the workspace default').toBeUndefined();
  });
});

describe('#1201 installs on a fresh workspace', () => {
  let ws: string;
  let out: {
    agents: Array<{ name: string; action: string }>;
    automations: Array<{ name: string; action: string; enabled?: boolean; switched_off_because?: string }>;
    triggers: Array<{ name: string; action: string; enabled?: boolean; switched_off_because?: string; human_gate?: boolean }>;
  };

  beforeAll(async () => {
    ws = await newWs('Fresh automations');
    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    out = res.json();
  });

  it('creates every automation and every agent', () => {
    for (const n of [...SPEC_RULES, ...EXTRA_RULES]) expect(out.automations.find((a) => a.name.endsWith(n)), n).toMatchObject({ action: 'created' });
    for (const n of AGENTS) expect(out.agents.find((a) => a.name === n), n).toMatchObject({ action: 'created' });
  });

  it('outward and agent-running rules install OFF, the rest ON', () => {
    const state = (n: string) => out.automations.find((a) => a.name.endsWith(n))!;
    expect(state('Won: tell Slack')).toMatchObject({ enabled: false, switched_off_because: 'outward' });
    expect(state('Monday pipeline review')).toMatchObject({ enabled: false, switched_off_because: 'agent' });
    for (const n of ['Stalled deal nudge', 'Lost needs a reason', 'Expire old quotes', 'Accepted quote moves the deal to Won', 'Stalled deals digest']) {
      expect(state(n).enabled, n).toBe(true);
    }
  });

  it('every agent wake installs OFF (#1192) and none is human-gated', () => {
    expect(out.triggers).toHaveLength(3);
    for (const t of out.triggers) {
      expect(t.enabled, t.name).toBe(false);
      expect(t.switched_off_because, t.name).toBe('wakes_agent');
      expect(t.human_gate, t.name).not.toBe(true);
    }
  });

  it('the live rules carry what the manifest says (refs resolved, sort + limit kept, approval kept, agent id resolved)', async () => {
    const deals = await liveRules(ws, 'Deals');
    const quotes = await liveRules(ws, 'Quotes');
    const digest = deals.find((r) => r.name === 'Stalled deals digest')!;
    expect(digest.sort).toEqual([{ field: 'updated_at', direction: 'asc' }]);
    expect((digest as unknown as { topNLimit: number }).topNLimit).toBe(5);
    expect(deals.find((r) => r.name === 'Won: tell Slack')!.enabled).toBe(false);
    const monday = deals.find((r) => r.name === 'Monday pipeline review')!;
    expect(monday.enabled).toBe(false);
    expect(String(monday.actions[0]!.agent), 'the $agent: ref became a real agent id').toMatch(/^[0-9a-f-]{36}$/);
    const accepted = quotes.find((r) => r.name === 'Accepted quote moves the deal to Won')!;
    expect(accepted.actions[0]).toMatchObject({ type: 'update_linked', require_approval: true });
    expect(JSON.stringify(accepted.actions[0]), 'no unresolved ref left').not.toContain('$option:');
    expect(JSON.stringify(accepted.actions[0]), 'no unresolved ref left').not.toContain('$field:');
    const expire = quotes.find((r) => r.name === 'Expire old quotes')!;
    expect(JSON.stringify(expire.actions[0])).not.toContain('$option:');
    expect(expire.enabled).toBe(true);
  });

  it('the agents exist as Agents records', async () => {
    const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
    const list = (await as('GET', `/workspaces/${ws}/databases/${ensured.agentsDb.id}/records?limit=200`)).json() as { data: Array<{ title: string }> };
    for (const n of AGENTS) expect(list.data.map((r) => r.title), n).toContain(n);
  });
});

describe('#1201 installs on a workspace that already has Agency OS', () => {
  it('installs the same rules and agents, wake switches still OFF, Contacts reused', async () => {
    const ws = await newWs('Agency OS automations');
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: agencyOs() })).statusCode).toBe(201);
    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    expect(out.automations).toHaveLength(7);
    expect(out.agents.map((a: { name: string }) => a.name).sort()).toEqual([...AGENTS].sort());
    for (const t of out.triggers) expect(t.enabled).toBe(false);
    expect(out.automations.find((a: { name: string }) => a.name.endsWith('Won: tell Slack')).enabled).toBe(false);
    expect((await dbsOf(ws)).filter((d) => d.name === 'Contacts')).toHaveLength(1);
  });
});

describe('#1201 a rule really does its job (the condition grammar is the one the engine runs)', () => {
  it('Expire old quotes: the scheduler sets an overdue Sent quote to Expired and leaves a Sent one that is still valid, and a Draft, alone', async () => {
    const ws = await newWs('Expire');
    expect((await install(ws)).statusCode).toBe(201);
    const quotesId = (await dbsOf(ws)).find((d) => d.name === 'Quotes')!.id;
    const det = (await as('GET', `/workspaces/${ws}/databases/${quotesId}`)).json() as { fields: Array<{ apiName: string; options?: Array<{ id: string; label: string }> }> };
    const opt = (label: string) => det.fields.find((f) => f.apiName === 'status')!.options!.find((o) => o.label === label)!.id;
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const make = async (name: string, status: string, validUntil: string) => {
      const r = await as('POST', `/workspaces/${ws}/databases/${quotesId}/records`, { values: { name, status: opt(status), valid_until: validUntil } });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const stale = await make('Stale sent', 'Sent', day(-3));
    const fresh = await make('Fresh sent', 'Sent', day(10));
    const draft = await make('Old draft', 'Draft', day(-3));
    const rule = (await liveRules(ws, 'Quotes')).find((r) => r.name === 'Expire old quotes')!;
    await rawDb.update(automations).set({ nextDueAt: new Date(Date.now() - 5000) }).where(eq(automations.id, rule.id));
    await app.get(AutomationsService).tick();
    const status = async (id: string) => (await as('GET', `/workspaces/${ws}/databases/${quotesId}/records/${id}`)).json().values.status as string;
    // the job runs through the durable queue: poll briefly
    for (let i = 0; i < 20 && (await status(stale)) !== opt('Expired'); i++) await new Promise((r) => setTimeout(r, 250));
    expect(await status(stale)).toBe(opt('Expired'));
    expect(await status(fresh)).toBe(opt('Sent'));
    expect(await status(draft)).toBe(opt('Draft'));
  });
});
