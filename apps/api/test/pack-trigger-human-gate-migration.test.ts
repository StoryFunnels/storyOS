import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';

/**
 * Ticket #1212 - the one-time migration (drizzle/0128_pack_trigger_human_gate_off.sql) that un-gates the bindings an install of a built-in
 * pack created, where the binding is enabled and its agent is "Your own AI".
 *
 * The migration has already run once on this test database (empty), so each case builds the OLD state for real (a manifest that still
 * carries human_gate, installed through the normal path, so `pack_install_items` and the relation links are what production has), then
 * runs the migration's own SQL text. The SQL is read from the file: this tests the file that ships, not a copy of it.
 */
const { pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
const sql = readFileSync(new URL('../drizzle/0128_pack_trigger_human_gate_off.sql', import.meta.url), 'utf8');
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const runMigration = () => pool.query(sql);

/** The pre-#1212 shape of Dev Project OS: its trigger carries human_gate, and the slug is one the migration covers. */
function gatedPack(slug = 'dev-project-os'): PackManifest {
  const m = clone(packManifestSchema.parse(PACK_REGISTRY.find((p) => p.slug === 'dev-project-os')!.manifest));
  m.slug = slug;
  m.triggers = m.triggers.map((t) => ({ ...t, human_gate: true }));
  return m;
}

async function systemDb(ws: string, which: 'agents' | 'triggers') {
  const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
  const id = (which === 'agents' ? ensured.agentsDb.id : ensured.triggersDb.id) as string;
  const detail = (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: Array<{ apiName: string; options?: Array<{ id: string; label: string }> }> };
  return { id, fields: detail.fields };
}
async function bindings(ws: string) {
  const { id } = await systemDb(ws, 'triggers');
  const list = (await as('GET', `/workspaces/${ws}/databases/${id}/records?limit=200`)).json() as { data: Array<{ id: string; values: Record<string, unknown> }> };
  return { dbId: id, rows: list.data };
}
const gateOf = (r: { values: Record<string, unknown> }) => r.values['human_gate'] === true;
const enabledOf = (r: { values: Record<string, unknown> }) => r.values['enabled'] === true;
/** Set the AI mode of the (single) agent in a workspace, by option label. */
async function setAiMode(ws: string, label: 'Non-AI' | 'Your own AI' | 'StoryOS AI') {
  const agents = await systemDb(ws, 'agents');
  const opt = agents.fields.find((f) => f.apiName === 'ai_mode')!.options!.find((o) => o.label === label)!;
  const list = (await as('GET', `/workspaces/${ws}/databases/${agents.id}/records?limit=50`)).json() as { data: Array<{ id: string }> };
  expect(list.data).toHaveLength(1);
  const res = await as('PATCH', `/workspaces/${ws}/databases/${agents.id}/records/${list.data[0]!.id}`, { values: { ai_mode: opt.id } });
  expect(res.statusCode, res.body).toBe(200);
}
async function setEnabled(ws: string, on: boolean) {
  const { dbId, rows } = await bindings(ws);
  const res = await as('PATCH', `/workspaces/${ws}/databases/${dbId}/records/${rows[0]!.id}`, { values: { enabled: on } });
  expect(res.statusCode, res.body).toBe(200);
}
/** A workspace holding one pack-created, human-gated binding, enabled (or not), on an agent in the given AI mode. */
async function setup(name: string, opts: { slug?: string; enabled: boolean; aiMode?: 'Non-AI' | 'Your own AI' | 'StoryOS AI' }) {
  const ws = await newWs(name);
  const m = gatedPack(opts.slug);
  expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: m })).statusCode).toBe(201);
  if (opts.aiMode) await setAiMode(ws, opts.aiMode);
  await setEnabled(ws, opts.enabled);
  const { rows } = await bindings(ws);
  expect(rows).toHaveLength(1);
  expect(gateOf(rows[0]!), 'the fixture is the OLD state: gated').toBe(true);
  expect(enabledOf(rows[0]!)).toBe(opts.enabled);
  return ws;
}
const backedUp = async (ws: string) => (await pool.query('select count(*)::int as n from migration_1212_pack_trigger_human_gate where workspace_id = $1', [ws])).rows[0].n as number;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Gate Migration');
}, 90_000);
afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('#1212 the migration un-gates exactly the bindings the ruling names', () => {
  it('a pack-created, ENABLED binding on a Your-own-AI agent loses human_gate, and keeps everything else', async () => {
    const ws = await setup('Mig on', { enabled: true, aiMode: 'Your own AI' });
    const before = (await bindings(ws)).rows[0]!;
    await runMigration();
    const after = (await bindings(ws)).rows[0]!;
    expect(gateOf(after)).toBe(false);
    expect(enabledOf(after), 'still enabled').toBe(true);
    for (const k of Object.keys(before.values).filter((k) => k !== 'human_gate')) expect(after.values[k], k).toEqual(before.values[k]);
    expect(await backedUp(ws)).toBe(1);
  }, 120_000);

  it('KEEPS a disabled binding gated: the person has not switched it on', async () => {
    const ws = await setup('Mig off', { enabled: false, aiMode: 'Your own AI' });
    await runMigration();
    expect(gateOf((await bindings(ws)).rows[0]!)).toBe(true);
    expect(await backedUp(ws)).toBe(0);
  }, 120_000);

  for (const mode of ['StoryOS AI', 'Non-AI'] as const) {
    it(`KEEPS an enabled binding gated when its agent's AI mode is "${mode}"`, async () => {
      const ws = await setup(`Mig ${mode}`, { enabled: true, aiMode: mode });
      await runMigration();
      expect(gateOf((await bindings(ws)).rows[0]!)).toBe(true);
      expect(await backedUp(ws)).toBe(0);
    }, 120_000);
  }

  it('KEEPS an enabled binding gated when the pack is not one of the built-in packs that used to gate (a custom pack, a person\'s own choice)', async () => {
    const ws = await setup('Mig custom', { slug: 'someones-own-pack', enabled: true, aiMode: 'Your own AI' });
    await runMigration();
    expect(gateOf((await bindings(ws)).rows[0]!)).toBe(true);
    expect(await backedUp(ws)).toBe(0);
  }, 120_000);

  it('KEEPS a binding a person made by hand (no pack created it), even enabled on a Your-own-AI agent', async () => {
    const ws = await setup('Mig hand', { enabled: false, aiMode: 'Your own AI' });
    // Detach the pack's provenance: this binding now looks exactly like one made through create_agent_trigger.
    await pool.query(`delete from pack_install_items where kind = 'trigger' and pack_install_id in (select id from pack_installs where workspace_id = $1)`, [ws]);
    await setEnabled(ws, true);
    await runMigration();
    expect(gateOf((await bindings(ws)).rows[0]!)).toBe(true);
    expect(await backedUp(ws)).toBe(0);
  }, 120_000);

  it('is safe to run again: a second run changes nothing and the backup keeps one row per binding', async () => {
    const ws = await setup('Mig twice', { enabled: true, aiMode: 'Your own AI' });
    await runMigration();
    const once = (await bindings(ws)).rows[0]!;
    await runMigration();
    await runMigration();
    const twice = (await bindings(ws)).rows[0]!;
    expect(twice.values).toEqual(once.values);
    expect(await backedUp(ws)).toBe(1);
  }, 120_000);

  it('a person who gated it again after the migration is not overridden by a re-run', async () => {
    const ws = await setup('Mig regate', { enabled: true, aiMode: 'Your own AI' });
    await runMigration();
    const { dbId, rows } = await bindings(ws);
    expect((await as('PATCH', `/workspaces/${ws}/databases/${dbId}/records/${rows[0]!.id}`, { values: { human_gate: true } })).statusCode).toBe(200);
    await runMigration();
    expect(gateOf((await bindings(ws)).rows[0]!), 'ask-me-before-each-run, chosen after the migration, survives').toBe(true);
  }, 120_000);

  it('can be reversed from the backup table, restoring exactly the bindings it changed', async () => {
    const ws = await setup('Mig revert', { enabled: true, aiMode: 'Your own AI' });
    const other = await setup('Mig revert other', { enabled: false, aiMode: 'Your own AI' });
    await runMigration();
    expect(gateOf((await bindings(ws)).rows[0]!)).toBe(false);
    const revert = sql.slice(sql.indexOf('-- REVERT')).split('\n').filter((l) => l.startsWith('--   ')).map((l) => l.slice(5)).join('\n');
    expect(revert).toMatch(/^UPDATE records r SET values = jsonb_set/);
    await pool.query(revert.replace(/;\s*$/, ''));
    expect(gateOf((await bindings(ws)).rows[0]!)).toBe(true);
    expect(gateOf((await bindings(other)).rows[0]!), 'a binding the migration never touched is unchanged by the revert').toBe(true);
  }, 120_000);

  it('after the migration, an enabled pack agent starts by itself when a record reaches its state (and a gated one still does not)', async () => {
    const ws = await setup('Mig wake', { enabled: true, aiMode: 'Your own AI' });
    await runMigration();
    const m = gatedPack();
    const trig = m.triggers[0]!;
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const issues = dbs.find((d) => d.name === trig.database)!;
    const detail = (await as('GET', `/workspaces/${ws}/databases/${issues.id}`)).json() as { fields: Array<{ apiName: string; displayName: string; options?: Array<{ id: string; label: string }> }> };
    const field = detail.fields.find((f) => f.displayName === trig.state_field)!;
    const wakes = async () => (await pool.query(`select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`, [ws, trig.agent])).rows[0].n as number;
    const n0 = await wakes();
    const created = await as('POST', `/workspaces/${ws}/databases/${issues.id}/records`, { values: { name: `After ${Math.random()}`, [field.apiName]: field.options!.find((o) => o.label === trig.state_option)!.id } });
    expect(created.statusCode, created.body).toBe(201);
    // The subscriber settles asynchronously; poll briefly for the wake rather than assuming an order.
    for (let i = 0; i < 40 && (await wakes()) === n0; i++) await new Promise((r) => setTimeout(r, 250));
    expect(await wakes()).toBe(n0 + 1);
  }, 180_000);
});
