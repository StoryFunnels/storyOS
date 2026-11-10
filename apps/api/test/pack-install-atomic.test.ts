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
import { RelationsService } from '../src/relations/relations.service';

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

/**
 * ticket #1246 - `required_packs: { "agency-os": "also_install" }` makes the request ONE install: when the dependent install fails at any
 * step, everything the request created goes - Agency OS's databases too - through the same compensating rollback as above, soft-deleted
 * rows counted. A required pack installed BEFORE the request is never touched.
 */
describe('ticket #1246 - an also_install request is one install', () => {
  const agencyOs = () => STARTER_PACKS.find((p) => p.slug === 'agency-os')!.manifest as PackManifest;
  /** Deal Desk: builds on Agency OS's Clients (linked), and has something at every install step of its own. */
  const dealDesk = (): PackManifest =>
    ({
      format_version: 1,
      slug: 'deal-desk-probe',
      name: 'Deal Desk Probe',
      version: '1.0.0',
      summary: 'Deals that hang off Agency OS clients',
      requires: { connections: [], ai: 'none', packs: [{ pack: 'agency-os', databases: ['Clients'] }] },
      databases: [
        { action: 'create', name: 'Clients', space: 'Deal Desk', fields: [{ name: 'Website', type: 'url' }, { name: 'Deal Value', type: 'number' }] },
        { action: 'create', name: 'Deals', space: 'Deal Desk', fields: [{ name: 'Amount', type: 'number' }] },
      ],
      relations: [{ from: 'Deals', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Deals' }],
      agents: [
        { name: 'Deal Scout', goal: 'g', instructions: 'i', scopes: ['read'], approval_policy: [], target_databases: ['Deals'], skills: [], ai_mode: 'your_own_ai' },
        { name: 'Deal Closer', goal: 'g', instructions: 'i', scopes: ['read'], approval_policy: [], target_databases: ['Deals'], skills: [], ai_mode: 'your_own_ai' },
      ],
      views: [{ database: 'Deals', name: 'Deal Table', type: 'table', config: {} }],
      automations: [{ database: 'Deals', name: 'Deal changed', trigger: { type: 'record_created' }, actions: [{ type: 'notify_user', user: '@me', message: 'A deal.' }], enabled: true }],
      sample_records: [{ database: 'Deals', values: { name: 'Sample deal (sample)' } }],
      skills: [{ name: 'Deal skill', description: 'd', when_to_use: 'w', instructions: 'i', examples: [], allowed_tools: [] }],
    }) as unknown as PackManifest;
  const also = { required_packs: { 'agency-os': 'also_install' } };
  const mentions = (text: string) => (a: unknown[]) => JSON.stringify(a).includes(text);
  const installedSlugs = async (ws: string) => ((await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ slug: string }>).map((i) => i.slug).sort();
  const dbIds = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string }>).map((d) => d.id).sort();
  const recordIds = async (ws: string) =>
    (await pool.query('select r.id from records r where r.database_id in (select id from databases where workspace_id=$1) order by r.id', [ws])).rows;
  const installRows = async (ws: string) => (await pool.query("select id from pack_installs where workspace_id=$1 and slug='agency-os'", [ws])).rows;

  /** Fail the dependent pack's own recordInstall only; the pack installed first records normally. */
  const failDependentRecord = () => {
    const service = app.get(PacksService, { strict: false }) as unknown as { recordInstall: (...a: unknown[]) => Promise<unknown> };
    const real = service.recordInstall.bind(service);
    vi.spyOn(service as never, 'recordInstall' as never).mockImplementation(((m: unknown, manifest: { slug: string }, ...rest: unknown[]) =>
      manifest.slug === 'deal-desk-probe' ? Promise.reject(new Error('injected failure in recordInstall')) : real(m, manifest, ...rest)) as never);
  };

  it('control: also_install builds both packs, linked to one Clients', async () => {
    const ws = await newWs('Also control');
    const res = await install(ws, dealDesk(), also);
    expect(res.statusCode, res.body).toBe(201);
    expect(await installedSlugs(ws)).toEqual(['agency-os', 'deal-desk-probe']);
    const clients = ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ name: string }>).filter((d) => d.name === 'Clients');
    expect(clients).toHaveLength(1);
  });

  const steps: Array<{ step: string; arm: () => void }> = [
    { step: "the dependent pack's own database field", arm: () => failOn(app.get(FieldsService, { strict: false }), 'create', 1, (a) => (a[1] as { display_name?: string } | undefined)?.display_name === 'Amount') },
    { step: 'the field it adds to the linked Clients', arm: () => failOn(app.get(FieldsService, { strict: false }), 'create', 1, (a) => (a[1] as { display_name?: string } | undefined)?.display_name === 'Deal Value') },
    { step: 'its relation', arm: () => failOn(app.get(RelationsService, { strict: false }), 'create', 1, mentions('Deals')) },
    { step: 'mid-agents', arm: () => failOn(app.get(RecordsService, { strict: false }), 'create', 1, (a) => (a[2] as { name?: string } | undefined)?.name === 'Deal Closer') },
    { step: 'a view', arm: () => failOn(app.get(ViewsService, { strict: false }), 'create', 1, mentions('Deal Table')) },
    { step: 'an automation', arm: () => failOn(app.get(AutomationsService, { strict: false }), 'create', 1, mentions('Deal changed')) },
    { step: 'a sample record', arm: () => failOn(app.get(RecordsService, { strict: false }), 'create', 1, mentions('Sample deal')) },
    { step: 'its bundled skill', arm: () => failOn(app.get(SkillsService, { strict: false }), 'create', 1, mentions('Deal skill')) },
    { step: 'recording the install', arm: failDependentRecord },
  ];

  for (const { step, arm } of steps) {
    it(`a failure of the dependent install at ${step} leaves the workspace exactly as it was (Agency OS gone too), and a re-install succeeds`, async () => {
      const ws = await newWs('Also failure');
      const before = await footprint(ws);
      arm();
      const failed = await install(ws, dealDesk(), also);
      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(failed.body).toMatch(/failed at/i);
      expect(failed.body, 'the error names what was rolled back').toMatch(/Rolled back everything this request had installed first: \\?"Agency OS\\?"/);
      expect(await installedSlugs(ws)).toEqual([]);
      expect(await footprint(ws), 'every row the request created is gone, soft-deleted ones included').toEqual(before);

      vi.restoreAllMocks();
      const retry = await install(ws, dealDesk(), also);
      expect(retry.statusCode, `re-install after the cause is gone: ${retry.body}`).toBe(201);
      expect(await installedSlugs(ws)).toEqual(['agency-os', 'deal-desk-probe']);
    });
  }

  it('a failure inside the also_install pack itself leaves nothing either', async () => {
    const ws = await newWs('Also nested failure');
    const before = await footprint(ws);
    const service = app.get(PacksService, { strict: false }) as unknown as { recordInstall: (...a: unknown[]) => Promise<unknown> };
    vi.spyOn(service as never, 'recordInstall' as never).mockRejectedValue(new Error('injected failure in recordInstall') as never);
    const failed = await install(ws, dealDesk(), also);
    expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
    expect(await footprint(ws)).toEqual(before);
    vi.restoreAllMocks();
    expect((await install(ws, dealDesk(), also)).statusCode).toBe(201);
  });

  for (const { step, arm } of [steps[1]!, steps[2]!, steps[3]!, steps[8]!]) {
    it(`a required pack installed BEFORE the request is untouched (same ids, same rows) when the dependent install fails at ${step}`, async () => {
      const ws = await newWs('Also preinstalled');
      expect((await install(ws, agencyOs())).statusCode).toBe(201);
      const before = await footprint(ws);
      const idsBefore = await dbIds(ws);
      const recordsBefore = await recordIds(ws);
      const installBefore = await installRows(ws);

      arm();
      const failed = await install(ws, dealDesk(), also); // Agency OS is already there: linked, never re-installed
      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(failed.body, 'nothing of this request was a separate pack install').not.toMatch(/Rolled back everything/);
      expect(await footprint(ws), 'only what the dependent install added is gone: Agency OS has exactly its own rows').toEqual(before);
      expect(await dbIds(ws)).toEqual(idsBefore);
      expect(await recordIds(ws)).toEqual(recordsBefore);
      expect(await installRows(ws)).toEqual(installBefore);

      vi.restoreAllMocks();
      const retry = await install(ws, dealDesk(), also);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(await installedSlugs(ws)).toEqual(['agency-os', 'deal-desk-probe']);
    });
  }
});
