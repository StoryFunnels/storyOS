import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { STARTER_PACKS } from '../src/packs/starter-packs';
import { PacksService } from '../src/packs/packs.service';
import { FieldsService } from '../src/fields/fields.service';
import { RecordsService } from '../src/records/records.service';
import { ViewsService } from '../src/views/views.service';
import { AutomationsService } from '../src/automations/automations.service';
import { SkillsService } from '../src/skills/skills.service';

/**
 * ticket #1112 — a pack install that fails midway used to leave everything it had already built (spaces, databases, fields, agents,
 * views, rules, sample records, skills), and installing again then 409'd on the names it had left. The install is all-or-nothing now:
 * a failure at ANY step removes exactly what that install created, names the step, and a re-install succeeds.
 *
 * Failures are injected by making one real service call throw, so every step is exercised through the real install code path.
 */
let app: NestFastifyApplication;
let admin: { token: string };
const { pool } = connectTestDb();

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const newWs = async (name: string) => {
  const res = await as('POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const install = (ws: string, manifest: unknown, extra: Record<string, unknown> = {}) =>
  as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...extra });

/**
 * Everything an install can leave (the workspace's own Members projection database is ambient: any member action provisions it lazily, so it is not pack debris), counted INCLUDING soft-deleted rows — a rollback that merely hides rows still leaves the names behind.
 */
async function footprint(ws: string): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await pool.query(sql, [ws])).rows[0].n);
  return {
    spaces: await n('select count(*) n from spaces where workspace_id=$1'),
    databases: await n("select count(*) n from databases where workspace_id=$1 and name <> 'Members'"),
    fields: await n('select count(*) n from fields f join databases d on d.id=f.database_id where d.workspace_id=$1 and d.name <> \'Members\''),
    records: await n('select count(*) n from records r join databases d on d.id=r.database_id where d.workspace_id=$1 and d.name <> \'Members\''),
    views: await n('select count(*) n from views v join databases d on d.id=v.database_id where d.workspace_id=$1 and d.name <> \'Members\''),
    automations: await n('select count(*) n from automations a join databases d on d.id=a.database_id where d.workspace_id=$1 and d.name <> \'Members\''),
    relations: await n('select count(*) n from relations where workspace_id=$1'),
    skills: await n('select count(*) n from skills where workspace_id=$1'),
    sample_registry: await n("select coalesce(jsonb_array_length(settings->'sample_record_ids'),0) n from workspaces where id=$1"),
    write_gates: await n('select count(*) n from agent_write_gates where workspace_id=$1'),
    pack_installs: await n('select count(*) n from pack_installs where workspace_id=$1'),
    pack_install_items: await n('select count(*) n from pack_install_items i join pack_installs p on p.id=i.pack_install_id where p.workspace_id=$1'),
  };
}

/** The starter pack with the most going on, plus a second agent and a bundled skill so every install step has something to build. */
function richManifest(): PackManifest {
  const base = STARTER_PACKS.find((p) => p.slug === 'agency-os')!.manifest as unknown as Record<string, unknown> & {
    agents: Array<Record<string, unknown>>;
    skills: unknown[];
  };
  const m = JSON.parse(JSON.stringify(base)) as typeof base;
  m.slug = 'atomic-install-probe';
  m.agents.push({ ...m.agents[0]!, name: 'Second Probe Agent', skills: [] });
  m.skills = [
    { name: 'Probe skill', description: 'd', when_to_use: 'w', instructions: 'i', examples: [], allowed_tools: [] },
  ];
  return m as unknown as PackManifest;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Atomic Install Admin');
}, 240_000);
afterAll(async () => {
  await app.close();
  await pool.end();
});
afterEach(() => vi.restoreAllMocks());

/** Make the `nth` (1-based) call to `service[method]` that matches `when` throw; every other call runs for real. */
function failOn<T extends object>(service: T, method: keyof T & string, nth: number, when: (args: unknown[]) => boolean = () => true) {
  const original = (service[method] as (...a: unknown[]) => unknown).bind(service);
  let seen = 0;
  vi.spyOn(service as never, method as never).mockImplementation(((...args: unknown[]) => {
    if (when(args) && ++seen === nth) throw new Error(`injected failure in ${method} (call ${nth})`);
    return original(...args);
  }) as never);
}

describe('ticket #1112 — a pack install is all-or-nothing', () => {
  it('control: the manifest installs, creates something at every step, and a second install of it is idempotent', async () => {
    const ws = await newWs('Atomic control');
    const before = await footprint(ws);
    const m = richManifest();
    const res = await install(ws, m);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    for (const k of ['databases', 'fields', 'agents', 'triggers', 'views', 'automations', 'sample_records', 'skills']) {
      expect(body[k].filter((e: { action: string }) => e.action === 'created').length, `${k} created`).toBeGreaterThan(0);
    }
    const after = await footprint(ws);
    expect(after.databases).toBeGreaterThan(before.databases);
    expect(after.pack_installs).toBe(before.pack_installs + 1);
    const again = await install(ws, m);
    expect(again.statusCode, again.body).toBe(201);
    expect((await footprint(ws)).databases).toBe(after.databases);
  });

  const points: Array<{ step: string; arm: (m: PackManifest) => void }> = [
    { step: 'the first database (its first field fails)', arm: (m) => {
        // The first field the pack itself creates on its first database (not a system database's field, which other code creates).
        const first = m.databases[0]!;
        const name = first.fields[first.fields.length - 1]!.name;
        failOn(app.get(FieldsService, { strict: false }), 'create', 1, (a) => (a[1] as { display_name?: string } | undefined)?.display_name === name);
      },
    },
    {
      step: 'mid-agents (the second agent record fails)',
      arm: (m) => failOn(app.get(RecordsService, { strict: false }), 'create', 1, (a) => (a[2] as { name?: string } | undefined)?.name === m.agents[1]!.name),
    },
    { step: 'a view', arm: () => failOn(app.get(ViewsService, { strict: false }), 'create', 2) },
    { step: 'the last automation', arm: () => failOn(app.get(AutomationsService, { strict: false }), 'create', 1) },
    { step: 'a sample record', arm: () => failOn(app.get(RecordsService, { strict: false }), 'create', 2, (a) => a[5] === 'automation') },
    { step: 'the last install step (a bundled skill)', arm: () => failOn(app.get(SkillsService, { strict: false }), 'create', 1) },
    {
      step: 'recording the install',
      arm: () => vi.spyOn(app.get(PacksService, { strict: false }) as never, 'recordInstall' as never).mockRejectedValue(new Error('injected failure in recordInstall') as never),
    },
  ];

  for (const { step, arm } of points) {
    it(`a failure at ${step} leaves the workspace exactly as it was, names the step, and a re-install then succeeds`, async () => {
      const ws = await newWs('Atomic failure');
      const m = richManifest();
      const before = await footprint(ws);

      arm(m);
      const failed = await install(ws, m);
      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(failed.body).toMatch(/nothing was installed/i);
      expect(failed.body).toMatch(/failed at/i);
      expect(await footprint(ws), 'every row the install created is gone, soft-deleted ones included').toEqual(before);

      vi.restoreAllMocks();
      const retry = await install(ws, m);
      expect(retry.statusCode, `re-install after the cause is gone: ${retry.body}`).toBe(201);
      const created = retry.json().databases.filter((d: { action: string }) => d.action === 'created');
      expect(created.length).toBeGreaterThan(0);
      const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ name: string }>;
      for (const d of created) expect(dbs.filter((x) => x.name === d.name), `${d.name} exists once`).toHaveLength(1);
    });
  }

  for (const failure of ['mid-agents', 'recording the install'] as const) {
    it(`with the Agentic OS already set up, a failure at ${failure} removes the agents and triggers the install created and keeps the Agentic OS`, async () => {
      const ws = await newWs('Atomic existing OS');
      expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
      const m = richManifest();
      const before = await footprint(ws);
      const osDbs = (await as('GET', `/workspaces/${ws}/databases`)).json().map((d: { name: string }) => d.name).filter((n: string) => ['Agents', 'Runs', 'Agent Triggers'].includes(n));
      expect(osDbs.length, 'the Agentic OS databases exist before the install').toBeGreaterThan(0);

      if (failure === 'mid-agents') {
        failOn(app.get(RecordsService, { strict: false }), 'create', 1, (a) => (a[2] as { name?: string } | undefined)?.name === m.agents[1]!.name);
      } else {
        vi.spyOn(app.get(PacksService, { strict: false }) as never, 'recordInstall' as never).mockRejectedValue(new Error('injected failure in recordInstall') as never);
      }
      const failed = await install(ws, m);
      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(await footprint(ws)).toEqual(before);
      const osAfter = (await as('GET', `/workspaces/${ws}/databases`)).json().map((d: { name: string }) => d.name).filter((n: string) => ['Agents', 'Runs', 'Agent Triggers'].includes(n));
      expect(osAfter.sort()).toEqual(osDbs.sort());

      vi.restoreAllMocks();
      const retry = await install(ws, m);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(retry.json().agents.filter((a: { action: string }) => a.action === 'created')).toHaveLength(2);
    });
  }

  it('a failed UPDATE of an installed pack removes only what that run added; everything already installed stays', async () => {
    const ws = await newWs('Atomic keeps existing');
    const v1 = richManifest();
    (v1 as unknown as { skills: unknown[] }).skills = [];
    const first = await install(ws, v1);
    expect(first.statusCode, first.body).toBe(201);
    const afterV1 = await footprint(ws);

    // v2 adds a bundled skill; recording the install fails after the skill was created. The skill goes, v1's install stays whole.
    const v2 = { ...richManifest(), version: '2.0.0' } as PackManifest;
    vi.spyOn(app.get(PacksService, { strict: false }) as never, 'recordInstall' as never).mockRejectedValue(new Error('injected failure in recordInstall') as never);
    const failed = await install(ws, v2);
    expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
    expect(await footprint(ws)).toEqual(afterV1);
    vi.restoreAllMocks();

    const retry = await install(ws, v2);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().skills.filter((s: { action: string }) => s.action === 'created')).toHaveLength(1);
  });
});
