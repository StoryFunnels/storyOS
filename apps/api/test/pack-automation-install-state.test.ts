import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { actionSchema, automationReach, installedEnabledState, ACTION_REACH, packManifestSchema } from '@storyos/schemas';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';

/**
 * Ticket #1107 — a pack automation that sends something outside the workspace, or runs an agent, installs SWITCHED OFF.
 *
 * Two layers: the classification (pure), and the install (real API). The classification is checked against what the action SCHEMA
 * declares, not a hand list, so an action type added later cannot be missed by this file.
 */
let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

const ACTION_TYPES = actionSchema.options.map((o) => (o.shape.type as unknown as { value: string }).value);

describe('#1107 classification', () => {
  it('classifies EVERY action type the schema declares (a new type cannot ship unclassified)', () => {
    expect(ACTION_TYPES.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(ACTION_REACH).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('what leaves the workspace is outward, agents are agent, the rest is internal', () => {
    const reach = (t: string) => automationReach([{ type: t }]);
    for (const t of ['send_email', 'send_slack_message', 'send_webhook', 'http_request', 'post_social']) expect(reach(t), t).toBe('outward');
    expect(reach('run_agent')).toBe('agent');
    for (const t of ['set_values', 'create_record', 'create_records', 'add_comment', 'notify_user', 'update_linked']) expect(reach(t), t).toBe('internal');
  });

  it('ONE outward action among internal ones makes the whole rule outward; outward beats agent', () => {
    expect(automationReach([{ type: 'set_values' }, { type: 'send_webhook' }, { type: 'notify_user' }])).toBe('outward');
    expect(automationReach([{ type: 'run_agent' }, { type: 'send_email' }])).toBe('outward');
    expect(automationReach([{ type: 'notify_user' }, { type: 'run_agent' }])).toBe('agent');
    expect(automationReach([])).toBe('internal');
  });

  it('an action type this build cannot classify counts as outward, never as quietly internal', () => {
    expect(automationReach([{ type: 'teleport' }])).toBe('outward');
    expect(automationReach([{}])).toBe('outward');
  });

  it('the manifest cannot force an outward or agent rule ON; only the person can; internal rules keep the manifest value', () => {
    expect(installedEnabledState([{ type: 'send_webhook' }], true)).toEqual({ enabled: false, switched_off_because: 'outward' });
    expect(installedEnabledState([{ type: 'run_agent' }], true)).toEqual({ enabled: false, switched_off_because: 'agent' });
    expect(installedEnabledState([{ type: 'send_webhook' }], true, true)).toEqual({ enabled: true });
    expect(installedEnabledState([{ type: 'notify_user' }], true)).toEqual({ enabled: true });
    // an internal rule the manifest switched off stays off, and says nothing about "because of what it does"
    expect(installedEnabledState([{ type: 'notify_user' }], false)).toEqual({ enabled: false });
  });
});

describe('#1107 every built-in pack, enumerated from the registry', () => {
  it('no automation of any built-in pack installs ON if it acts outward or runs an agent', () => {
    expect(PACK_REGISTRY.length).toBeGreaterThan(5);
    let seen = 0;
    for (const pack of PACK_REGISTRY) {
      const manifest = packManifestSchema.parse(pack.manifest);
      for (const rule of manifest.automations) {
        seen++;
        const state = installedEnabledState(rule.actions, rule.enabled);
        if (automationReach(rule.actions) !== 'internal') expect(state.enabled, `${pack.slug}: ${rule.name}`).toBe(false);
        else expect(state.enabled, `${pack.slug}: ${rule.name} (internal keeps the manifest flag)`).toBe(rule.enabled);
      }
    }
    expect(seen, 'the registry has automations to check').toBeGreaterThan(0);
  });

  it('the check is not vacuous: an outward rule added to a built-in manifest WITH enabled:true is caught as off', () => {
    const base = packManifestSchema.parse(PACK_REGISTRY.find((p) => p.manifest.automations.length > 0)!.manifest);
    base.automations.push({
      database: base.automations[0]!.database,
      name: 'Post to a webhook',
      trigger: { type: 'record_created' },
      actions: [{ type: 'send_webhook', url: 'https://example.com/hook' }],
      enabled: true,
    });
    const rule = base.automations.at(-1)!;
    expect(rule.enabled).toBe(true);
    expect(installedEnabledState(rule.actions, rule.enabled).enabled).toBe(false);
  });
});

/** A small real pack: one database, five rules of different reach. */
function manifest(slug: string): PackManifest {
  const support = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest;
  const m = JSON.parse(JSON.stringify(support)) as PackManifest;
  m.slug = slug;
  const database = m.databases[0]!.name;
  const trigger = { type: 'record_created' };
  m.automations = [
    { database, name: 'Notify members', trigger, actions: [{ type: 'notify_user', user: '@me', message: 'New record.' }], enabled: true },
    { database, name: 'Internal but off in the pack', trigger, actions: [{ type: 'notify_user', user: '@me', message: 'Quiet.' }], enabled: false },
    { database, name: 'Slack it', trigger, actions: [{ type: 'send_slack_message', text: 'New record' }], enabled: true },
    { database, name: 'Call the hook', trigger, actions: [{ type: 'send_webhook', url: 'https://example.com/hook' }], enabled: true },
    { database, name: 'Call an API', trigger, actions: [{ type: 'http_request', method: 'GET', url: 'https://example.com/api' }], enabled: true },
  ] as never;
  return m;
}
const label = (m: PackManifest, name: string) => `${m.automations[0]!.database}.${name}`;
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const install = (ws: string, m: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, ...extra });
const preview = (ws: string, m: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m, ...extra });
async function liveRules(ws: string, m: PackManifest) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const db = dbs.find((d) => d.name === m.automations[0]!.database)!;
  const { data } = (await as('GET', `/workspaces/${ws}/databases/${db.id}/automations`)).json() as { data: Array<{ id: string; name: string; enabled: boolean }> };
  return new Map(data.map((r) => [r.name, r] as const));
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Reach');
}, 90_000);
afterAll(async () => { await app?.close(); });

describe('#1107 install', () => {
  it('outward rules are created OFF even though the manifest says enabled:true; internal rules keep the manifest value; the result says which and why', async () => {
    const m = manifest('reach-install');
    const ws = await newWs('Reach install');
    const res = await install(ws, m);
    expect(res.statusCode, res.body).toBe(201);
    const live = await liveRules(ws, m);
    expect(live.get('Notify members')!.enabled).toBe(true);
    expect(live.get('Internal but off in the pack')!.enabled).toBe(false);
    for (const n of ['Slack it', 'Call the hook', 'Call an API']) expect(live.get(n)!.enabled, n).toBe(false);

    const byName = new Map((res.json().automations as Array<{ name: string; action: string; enabled?: boolean; switched_off_because?: string }>).map((a) => [a.name, a] as const));
    expect(byName.get(label(m, 'Notify members'))).toMatchObject({ action: 'created', enabled: true });
    expect(byName.get(label(m, 'Notify members'))!.switched_off_because).toBeUndefined();
    expect(byName.get(label(m, 'Internal but off in the pack'))).toMatchObject({ enabled: false });
    expect(byName.get(label(m, 'Internal but off in the pack'))!.switched_off_because).toBeUndefined();
    for (const n of ['Slack it', 'Call the hook', 'Call an API']) expect(byName.get(label(m, n)), n).toMatchObject({ action: 'created', enabled: false, switched_off_because: 'outward' });
  }, 90_000);

  it('preview states the same on/off and why, before anything is installed (and writes nothing)', async () => {
    const m = manifest('reach-preview');
    const ws = await newWs('Reach preview');
    const res = await preview(ws, m);
    expect(res.statusCode, res.body).toBe(201);
    const items = new Map((res.json().automations as Array<{ name: string; enabled_on_install?: boolean; switched_off_because?: string }>).map((a) => [a.name, a] as const));
    expect(items.get(label(m, 'Notify members'))).toMatchObject({ enabled_on_install: true });
    expect(items.get(label(m, 'Internal but off in the pack'))).toMatchObject({ enabled_on_install: false });
    expect(items.get(label(m, 'Call the hook'))).toMatchObject({ enabled_on_install: false, switched_off_because: 'outward' });
  }, 90_000);

  it('the person can switch an outward rule ON in the review (preview shows it, install does it); other outward rules stay off', async () => {
    const m = manifest('reach-person');
    const ws = await newWs('Reach person');
    const pick = [label(m, 'Call the hook')];
    const pv = await preview(ws, m, { enable_automations: pick });
    const item = (pv.json().automations as Array<{ name: string; enabled_on_install?: boolean }>).find((a) => a.name === pick[0])!;
    expect(item.enabled_on_install).toBe(true);
    expect((await install(ws, m, { enable_automations: pick })).statusCode).toBe(201);
    const live = await liveRules(ws, m);
    expect(live.get('Call the hook')!.enabled).toBe(true);
    expect(live.get('Slack it')!.enabled).toBe(false);
    expect(live.get('Call an API')!.enabled).toBe(false);
  }, 90_000);

  it('re-installing never flips a rule: one a person switched ON stays on, one they switched OFF stays off', async () => {
    const m = manifest('reach-reinstall');
    const ws = await newWs('Reach reinstall');
    expect((await install(ws, m)).statusCode).toBe(201);
    let live = await liveRules(ws, m);
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const dbId = dbs.find((d) => d.name === m.automations[0]!.database)!.id;
    const patch = (id: string, enabled: boolean) => as('PATCH', `/workspaces/${ws}/databases/${dbId}/automations/${id}`, { enabled });
    expect((await patch(live.get('Call the hook')!.id, true)).statusCode).toBe(200);
    expect((await patch(live.get('Notify members')!.id, false)).statusCode).toBe(200);

    const again = await install(ws, m);
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json().automations as Array<{ action: string }>).every((a) => a.action === 'reused')).toBe(true);
    live = await liveRules(ws, m);
    expect(live.get('Call the hook')!.enabled, 'a person turned it on').toBe(true);
    expect(live.get('Notify members')!.enabled, 'a person turned it off').toBe(false);
    expect(live.get('Slack it')!.enabled).toBe(false);
  }, 90_000);

  it('uninstall does not call a rule installed OFF "modified" (the install hash uses the effective flag)', async () => {
    const m = manifest('reach-uninstall');
    const ws = await newWs('Reach uninstall');
    expect((await install(ws, m)).statusCode).toBe(201);
    const installs = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }> | { data: Array<{ id: string; slug: string }> };
    const list = Array.isArray(installs) ? installs : installs.data;
    const mine = list.find((i) => i.slug === 'reach-uninstall')!;
    const un = await as('POST', `/workspaces/${ws}/packs/${mine.id}/uninstall`);
    expect(un.statusCode, un.body).toBe(201);
    const { removed, kept } = un.json() as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string }> };
    expect(kept.filter((k) => k.kind === 'automation')).toEqual([]);
    expect(removed.filter((r) => r.kind === 'automation').length).toBe(m.automations.length);
  }, 90_000);

  it('export then install round-trips: an exported outward rule installs off again', async () => {
    const m = manifest('reach-export-src');
    const src = await newWs('Reach export src');
    expect((await install(src, m)).statusCode).toBe(201);
    const ex = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'reach-exported', name: 'Reach exported', version: '1.0.0', summary: 'x', space: (m.databases[0] as { space: string }).space });
    expect(ex.statusCode, ex.body).toBe(201);
    const exported = ex.json() as PackManifest;
    expect(exported.automations.map((a) => a.name).sort()).toEqual(m.automations.map((a) => a.name).sort());
    const dst = await newWs('Reach export dst');
    expect((await install(dst, exported)).statusCode).toBe(201);
    const live = await liveRules(dst, exported);
    for (const n of ['Slack it', 'Call the hook', 'Call an API']) expect(live.get(n)!.enabled, n).toBe(false);
    expect(live.get('Notify members')!.enabled).toBe(true);
  }, 120_000);
});
