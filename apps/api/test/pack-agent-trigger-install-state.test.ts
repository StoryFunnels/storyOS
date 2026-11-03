import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { installedTriggerState, packManifestSchema } from '@storyos/schemas';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { PACK_REGISTRY } from '../src/packs/registry';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';

/**
 * Ticket #1192 - a pack's AGENT TRIGGERS (an agent bound to a state change) install OFF, like #1107's outward automations: installing a
 * pack must never start an agent by itself. Only a person, in the install review, switches one on.
 *
 * Real fixtures: an admin installs, a member moves records, a guest tries to install. Every built-in pack is enumerated from the registry.
 */
const { pool } = connectTestDb();
let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const install = (ws: string, m: unknown, extra: Record<string, unknown> = {}, token = admin.token) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, ...extra }, token);
const preview = (ws: string, m: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m, ...extra });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const label = (t: { agent: string; database: string; state_field: string; state_option: string }) => `${t.agent} ← ${t.database}.${t.state_field} = ${t.state_option}`;

interface TriggerOut { name: string; action: string; id: string; enabled?: boolean; switched_off_because?: string; human_gate?: boolean }

/** Every binding on the Agent Triggers database, by its record name, with the live `enabled`. */
async function liveBindings(ws: string) {
  const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
  const list = (await as('GET', `/workspaces/${ws}/databases/${ensured.triggersDb.id}/records?limit=200`)).json() as { data: Array<{ id: string; title: string; values: Record<string, unknown> }> };
  return { triggersDbId: ensured.triggersDb.id as string, rows: list.data };
}
const enabledOf = (r: { values: Record<string, unknown> }) => r.values['enabled'] === true;

const supportInbox = () => clone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as PackManifest;
/** support-inbox with the slug changed, so each test installs into its own workspace without a name clash. */
const withSlug = (m: PackManifest, slug: string) => ({ ...m, slug });
const nonGated = (m: PackManifest) => m.triggers.filter((t) => !t.human_gate);

async function ticketsOf(ws: string) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const id = dbs.find((d) => d.name === 'Tickets')!.id;
  const detail = (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: Array<{ id: string; apiName: string; displayName: string; options?: Array<{ id: string; label: string }> }> };
  const status = detail.fields.find((f) => f.displayName === 'Status')!;
  return { id, status, option: (l: string) => status.options!.find((o) => o.label === l)!.id };
}
async function mkTicket(ws: string, t: Awaited<ReturnType<typeof ticketsOf>>, state: string, token = admin.token) {
  const res = await as('POST', `/workspaces/${ws}/databases/${t.id}/records`, { values: { name: `Ticket ${Math.random()}`, [t.status.apiName]: t.option(state) } }, token);
  expect(res.statusCode, res.body).toBe(201);
  await subscriber.settle(res.json().id);
  return res.json().id as string;
}
/** Wait for the trigger subscriber to finish with EVERY ticket (the pack's own sample ticket included), so a count of 0 is a real 0 and not a race. */
async function settleTickets(ws: string, t: Awaited<ReturnType<typeof ticketsOf>>) {
  const list = (await as('GET', `/workspaces/${ws}/databases/${t.id}/records?limit=200`)).json() as { data: Array<{ id: string }> };
  for (const r of list.data) await subscriber.settle(r.id);
}
async function wakesFor(ws: string, agentName: string): Promise<number> {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const tickets = dbs.find((d) => d.name === 'Tickets');
  if (tickets) await settleTickets(ws, { id: tickets.id } as Awaited<ReturnType<typeof ticketsOf>>);
  const { rows } = await pool.query(
    `select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`,
    [ws, agentName],
  );
  return rows[0].n as number;
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'Trigger Install');
}, 90_000);
afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('#1192 the rule (pure)', () => {
  it('a state-bound trigger is off unless a person turned it on; a human-gated one is unchanged (it never fires by itself)', () => {
    expect(installedTriggerState(false)).toEqual({ enabled: false, switched_off_because: 'wakes_agent' });
    expect(installedTriggerState(false, true)).toEqual({ enabled: true });
    expect(installedTriggerState(true)).toEqual({ enabled: true });
    expect(installedTriggerState(true, true)).toEqual({ enabled: true });
  });

  it('the trigger schema has NO enabled field: a manifest carrying one has it stripped, so it cannot force a trigger on', () => {
    const m = supportInbox();
    const raw = clone(m) as unknown as { triggers: Array<Record<string, unknown>> };
    raw.triggers[0]!['enabled'] = true;
    const parsed = packManifestSchema.parse(raw);
    expect(parsed.triggers[0]).not.toHaveProperty('enabled');
  });

  it('the registry has non-gated triggers to check (the loop below is not vacuous)', () => {
    const all = PACK_REGISTRY.flatMap((p) => p.manifest.triggers.map((t) => ({ slug: p.slug, t })));
    expect(PACK_REGISTRY.length).toBeGreaterThan(8);
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((x) => !x.t.human_gate).length).toBeGreaterThan(0);
    expect(all.filter((x) => x.t.human_gate).length).toBeGreaterThan(0);
  });
});

describe('#1192 every built-in pack, installed for real', () => {
  const withTriggers = PACK_REGISTRY.filter((p) => p.manifest.triggers.length > 0);
  it('there are packs with triggers to loop over', () => {
    expect(withTriggers.length).toBeGreaterThanOrEqual(8);
  });

  for (const pack of withTriggers) {
    it(`${pack.slug}: preview lists every trigger with its state, install matches, and no live binding that fires by itself is on`, async () => {
      const m = packManifestSchema.parse(pack.manifest);
      const ws = await newWs(`Trig ${pack.slug}`);

      const pv = await preview(ws, m);
      expect(pv.statusCode, pv.body).toBe(201);
      const pvItems = pv.json().triggers as Array<{ name: string; action: string; enabled_on_install?: boolean; switched_off_because?: string; human_gate?: boolean }>;
      expect(pvItems.map((i) => i.name).sort()).toEqual(m.triggers.map(label).sort());
      for (const t of m.triggers) {
        const item = pvItems.find((i) => i.name === label(t))!;
        expect(item.action).toBe('create');
        if (t.human_gate) expect(item, label(t)).toMatchObject({ enabled_on_install: true, human_gate: true });
        else expect(item, label(t)).toMatchObject({ enabled_on_install: false, switched_off_because: 'wakes_agent' });
        if (!t.human_gate) expect(item.human_gate).toBeUndefined();
      }

      const res = await install(ws, m);
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json().triggers as TriggerOut[];
      expect(out.length).toBe(m.triggers.length);
      const { rows } = await liveBindings(ws);
      for (const t of m.triggers) {
        const r = out.find((o) => o.name === label(t))!;
        expect(r.action).toBe('created');
        const live = rows.find((x) => x.id === r.id)!;
        if (t.human_gate) {
          expect(r, label(t)).toMatchObject({ enabled: true, human_gate: true });
          expect(enabledOf(live)).toBe(true);
        } else {
          expect(r, label(t)).toMatchObject({ enabled: false, switched_off_because: 'wakes_agent' });
          expect(enabledOf(live), `${pack.slug}: ${label(t)} must be off in the database`).toBe(false);
        }
      }
      // The preview told the truth about the install.
      for (const i of pvItems) expect(out.find((o) => o.name === i.name)!.enabled).toBe(i.enabled_on_install);
    }, 120_000);
  }
});

describe('#1192 a state change after install', () => {
  it('Support Inbox: moving tickets into the bound state creates NO wake until a person switches the trigger on; then it does', async () => {
    const m = withSlug(supportInbox(), 'trig-wake');
    const ws = await newWs('Trig wake');
    expect((await install(ws, m)).statusCode).toBe(201);
    const member = await joinAs(app, admin.token, ws, 'Trig Member', 'member');
    const t = await ticketsOf(ws);

    await mkTicket(ws, t, 'New', member.token);
    await mkTicket(ws, t, 'New');
    expect(await wakesFor(ws, 'Triage'), 'nothing started by itself').toBe(0);

    // A person turns it on (an ordinary edit of the binding, as the Agent Triggers database shows it).
    const { triggersDbId, rows } = await liveBindings(ws);
    expect(rows).toHaveLength(1);
    const patched = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${rows[0]!.id}`, { values: { enabled: true } });
    expect(patched.statusCode, patched.body).toBe(200);

    await mkTicket(ws, t, 'New', member.token);
    expect(await wakesFor(ws, 'Triage'), 'now it wakes the agent').toBe(1);
  }, 120_000);

  it('switching it on IN THE REVIEW (enable_agent_triggers) installs it on, preview shows that, and it then wakes', async () => {
    const m = withSlug(supportInbox(), 'trig-review-on');
    const ws = await newWs('Trig review on');
    const pick = [label(m.triggers[0]!)];
    const pv = await preview(ws, m, { enable_agent_triggers: pick });
    expect((pv.json().triggers as Array<{ name: string; enabled_on_install?: boolean; switched_off_because?: string }>).find((i) => i.name === pick[0])).toMatchObject({ enabled_on_install: true });
    expect((pv.json().triggers as Array<{ switched_off_because?: string }>)[0]!.switched_off_because).toBeUndefined();
    const res = await install(ws, m, { enable_agent_triggers: pick });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().triggers as TriggerOut[])[0]).toMatchObject({ action: 'created', enabled: true });
    // The person chose it on, so the pack's own sample ticket (already in New) woke the agent once; one more ticket makes two.
    expect(await wakesFor(ws, 'Triage')).toBe(1);
    const t = await ticketsOf(ws);
    await mkTicket(ws, t, 'New');
    expect(await wakesFor(ws, 'Triage')).toBe(2);
  }, 120_000);

  it('a label that names no trigger (or an automation list) turns nothing on', async () => {
    const m = withSlug(supportInbox(), 'trig-wrong-label');
    const ws = await newWs('Trig wrong label');
    const res = await install(ws, m, { enable_agent_triggers: ['Nobody ← Nothing.Here = There'], enable_automations: [label(m.triggers[0]!)] });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().triggers as TriggerOut[])[0]).toMatchObject({ enabled: false });
    const t = await ticketsOf(ws);
    await mkTicket(ws, t, 'New');
    expect(await wakesFor(ws, 'Triage')).toBe(0);
  }, 120_000);
});

describe('#1192 a manifest cannot force a trigger on', () => {
  it('enabled:true on a trigger in the file installs OFF (the field is stripped), in preview and in install', async () => {
    const raw = clone(withSlug(supportInbox(), 'trig-forced')) as unknown as { triggers: Array<Record<string, unknown>> };
    raw.triggers[0]!['enabled'] = true;
    const ws = await newWs('Trig forced');
    const pv = await preview(ws, raw);
    expect(pv.statusCode, pv.body).toBe(201);
    expect((pv.json().triggers as Array<{ enabled_on_install?: boolean }>)[0]).toMatchObject({ enabled_on_install: false });
    const res = await install(ws, raw);
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().triggers as TriggerOut[])[0]).toMatchObject({ enabled: false });
    const { rows } = await liveBindings(ws);
    expect(rows.every((r) => !enabledOf(r))).toBe(true);
  }, 120_000);
});

describe('#1192 re-install and update never flip what a person set', () => {
  /** Two non-gated triggers on the same pack: one on New, one on To Do. */
  const twoTriggers = (slug: string, version = '1.0.0') => {
    const m = withSlug(supportInbox(), slug);
    m.version = version;
    m.triggers = [m.triggers[0]!, { ...m.triggers[0]!, state_option: 'To Do' }];
    return m;
  };

  it('re-install keeps the one a person turned ON, and does not turn on the one they left OFF; preview calls both reuse with no state', async () => {
    const m = twoTriggers('trig-reinstall');
    const ws = await newWs('Trig reinstall');
    const first = await install(ws, m);
    expect(first.statusCode, first.body).toBe(201);
    const ids = new Map((first.json().triggers as TriggerOut[]).map((t) => [t.name, t.id] as const));
    const { triggersDbId } = await liveBindings(ws);
    const on = label(m.triggers[0]!);
    const off = label(m.triggers[1]!);
    expect((await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${ids.get(on)}`, { values: { enabled: true } })).statusCode).toBe(200);

    const pv = await preview(ws, m);
    for (const i of pv.json().triggers as Array<{ action: string; enabled_on_install?: boolean; switched_off_because?: string }>) {
      expect(i.action).toBe('reuse');
      expect(i.enabled_on_install).toBeUndefined();
      expect(i.switched_off_because).toBeUndefined();
    }
    const again = await install(ws, m);
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json().triggers as TriggerOut[]).every((t) => t.action === 'reused')).toBe(true);
    // Even a re-install that ASKS for the left-off one on does not change an existing binding: only a person's edit does.
    const askAgain = await install(ws, m, { enable_agent_triggers: [off] });
    expect(askAgain.statusCode, askAgain.body).toBe(201);
    const { rows } = await liveBindings(ws);
    expect(rows.find((r) => r.id === ids.get(on))!.values['enabled'], 'person turned it on').toBe(true);
    expect(rows.find((r) => r.id === ids.get(off))!.values['enabled'], 'person left it off').toBe(false);
  }, 120_000);

  it('a person who switched one OFF after it was on stays off on re-install', async () => {
    const m = twoTriggers('trig-reinstall-off');
    const ws = await newWs('Trig reinstall off');
    const on = label(m.triggers[0]!);
    const first = await install(ws, m, { enable_agent_triggers: [on] });
    const ids = new Map((first.json().triggers as TriggerOut[]).map((t) => [t.name, t.id] as const));
    const { triggersDbId } = await liveBindings(ws);
    await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${ids.get(on)}`, { values: { enabled: false } });
    expect((await install(ws, m, { enable_agent_triggers: [on] })).statusCode).toBe(201);
    const { rows } = await liveBindings(ws);
    expect(rows.every((r) => !enabledOf(r))).toBe(true);
  }, 120_000);

  it('an UPDATE (new version) that adds a trigger creates it OFF and leaves the person-enabled one on', async () => {
    const v1 = withSlug(supportInbox(), 'trig-update');
    const ws = await newWs('Trig update');
    const first = await install(ws, v1);
    expect(first.statusCode, first.body).toBe(201);
    const { triggersDbId } = await liveBindings(ws);
    const id = (first.json().triggers as TriggerOut[])[0]!.id;
    await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${id}`, { values: { enabled: true } });

    const v2 = clone(v1);
    v2.version = '1.1.0';
    v2.triggers = [...v1.triggers, { ...v1.triggers[0]!, state_option: 'Review' }];
    const pv = await preview(ws, v2);
    const items = pv.json().triggers as Array<{ name: string; action: string; enabled_on_install?: boolean }>;
    expect(items.find((i) => i.name === label(v1.triggers[0]!))!.action).toBe('reuse');
    expect(items.find((i) => i.name === label(v2.triggers[1]!))).toMatchObject({ action: 'create', enabled_on_install: false });
    const up = await install(ws, v2);
    expect(up.statusCode, up.body).toBe(201);
    const out = up.json().triggers as TriggerOut[];
    expect(out.find((o) => o.name === label(v1.triggers[0]!))!.action).toBe('reused');
    expect(out.find((o) => o.name === label(v2.triggers[1]!))).toMatchObject({ action: 'created', enabled: false });
    const { rows } = await liveBindings(ws);
    expect(rows.find((r) => r.id === id)!.values['enabled']).toBe(true);
    expect(rows.filter(enabledOf)).toHaveLength(1);
  }, 120_000);

  it('uninstall removes a trigger installed off (nothing about the off state reads as "modified")', async () => {
    const m = withSlug(supportInbox(), 'trig-uninstall');
    const ws = await newWs('Trig uninstall');
    expect((await install(ws, m)).statusCode).toBe(201);
    const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }> | { data: Array<{ id: string; slug: string }> };
    const mine = (Array.isArray(list) ? list : list.data).find((i) => i.slug === 'trig-uninstall')!;
    const un = await as('POST', `/workspaces/${ws}/packs/${mine.id}/uninstall`);
    expect(un.statusCode, un.body).toBe(201);
    const { rows } = await liveBindings(ws);
    expect(rows).toHaveLength(0);
  }, 120_000);
});

describe('#1192 what is NOT changed', () => {
  it('the Architect\'s own approved plan still builds its triggers ON (a person approved the plan; it is not a pack install)', async () => {
    const ws = await newWs('Trig architect');
    const plan = {
      summary: 'Triage new tickets with an agent.',
      scenario: 'triggers-own-plan',
      databases: [{ action: 'create', name: 'Tickets', space: 'Support', fields: [] }],
      relations: [],
      states: [{ database: 'Tickets', field: 'Status', options: [{ label: 'New', color: 'gray' }, { label: 'Done', color: 'green' }] }],
      agents: [{ name: 'Plan Triage', goal: 'Triage.', scopes: ['read'], approval_policy: [], target_databases: ['Tickets'] }],
      triggers: [{ agent: 'Plan Triage', database: 'Tickets', state_field: 'Status', state_option: 'New', human_gate: false }],
    };
    const res = await as('POST', `/workspaces/${ws}/architect/build`, { plan });
    expect(res.statusCode, res.body).toBe(201);
    const { rows } = await liveBindings(ws);
    expect(rows).toHaveLength(1);
    expect(enabledOf(rows[0]!)).toBe(true);
  }, 120_000);

  it('an existing workspace\'s enabled bindings are not touched by a later install of another pack', async () => {
    const ws = await newWs('Trig existing');
    const first = await install(ws, withSlug(supportInbox(), 'trig-existing-a'), { enable_agent_triggers: [label(supportInbox().triggers[0]!)] });
    expect(first.statusCode, first.body).toBe(201);
    const idA = (first.json().triggers as TriggerOut[])[0]!.id;
    const other = PACK_REGISTRY.find((p) => p.slug === 'dev-project-os' || p.slug === 'dev-tracker')!;
    expect((await install(ws, packManifestSchema.parse(other.manifest))).statusCode).toBe(201);
    const { rows } = await liveBindings(ws);
    expect(rows.find((r) => r.id === idA)!.values['enabled']).toBe(true);
  }, 180_000);

  it('a guest cannot install a pack (so cannot switch a trigger on through one)', async () => {
    const ws = await newWs('Trig guest');
    const spaceId = ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const guest = await joinAs(app, admin.token, ws, 'Trig Guest', 'guest', [{ space_id: spaceId, role: 'viewer' }]);
    const res = await call(app, guest.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: withSlug(supportInbox(), 'trig-guest'), enable_agent_triggers: [label(supportInbox().triggers[0]!)] });
    expect([403, 404]).toContain(res.statusCode);
    expect((await liveBindings(ws)).rows).toHaveLength(0);
  }, 120_000);
});
