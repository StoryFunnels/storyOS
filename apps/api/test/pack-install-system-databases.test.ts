import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1166 — a pack install never matches, reuses, adopts or modifies a SYSTEM database (Members, Agents, Agent Triggers, Agent Runs), however
 * it is asked: by name, by an explicit `reuse`, as a target of sample records, on update or on uninstall. System databases are identified
 * by the `is_system` flag (ADR-0017), never by their name, so a pack's own database that happens to be called "Members" is an ordinary one.
 */
let app: NestFastifyApplication;
let admin: { token: string };

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
type Db = { id: string; name: string; spaceId: string; isSystem?: boolean };
const dbsOf = async (ws: string) => (await as('GET', `/workspaces/${ws}/databases`)).json() as Db[];
const detail = async (ws: string, id: string) => (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: unknown[] };
const recordsOf = async (ws: string, id: string) => (await as('GET', `/workspaces/${ws}/databases/${id}/records?limit=200`)).json() as { data: unknown[] };
/** Everything about a database a pack could change: its fields and its records, as one comparable string. */
const snapshot = async (ws: string, id: string) => JSON.stringify([(await detail(ws, id)).fields, (await recordsOf(ws, id)).data]);
const packNamed = (dbName: string, slug = 'sys-name-probe') => ({
  format_version: 1, slug, name: `Probe ${dbName}`, version: '1.0.0', summary: 's', scenario: 'pack',
  databases: [{ action: 'create', name: dbName, space: 'Probe space', fields: [{ name: 'Pack field', type: 'text' }] }],
  relations: [], states: [], agents: [], triggers: [], views: [], automations: [], derived_fields: [],
  sample_records: [{ database: dbName, values: { name: 'Pack sample' } }], skills: [],
  requires: { connections: [], ai: 'none' }, license: 'All rights reserved',
});
const install = (ws: string, manifest: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...extra });
const preview = (ws: string, manifest: unknown, extra: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/preview`, { manifest, ...extra });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'System Databases');
}, 120_000);
afterAll(async () => { await app.close(); });

/** A workspace that has every kind of system database: Members from the start, the agent ones once the Agentic OS is provisioned. */
async function workspaceWithSystemDatabases() {
  const ws = await newWs('System dbs');
  expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
  const system = (await dbsOf(ws)).filter((d) => d.isSystem);
  expect(system.map((d) => d.name).sort(), 'Members and the three agent databases').toEqual(expect.arrayContaining(['Members']));
  expect(system.length, 'all four system databases exist').toBeGreaterThanOrEqual(4);
  return { ws, system };
}

describe('#1166 a pack never writes into a system database', () => {
  it('an explicit reuse of each system database, into the very space that holds it, is refused 422 and the database is byte-for-byte unchanged', async () => {
    const { ws, system } = await workspaceWithSystemDatabases();
    for (const sys of system) {
      const before = await snapshot(ws, sys.id);
      const res = await install(ws, packNamed(sys.name), { target_space_id: sys.spaceId, resolutions: { [sys.name]: { action: 'reuse' } } });
      expect(res.statusCode, `${sys.name}: ${res.body}`).toBe(422);
      expect(res.json().error.message, 'says why, plainly').toContain('built-in');
      expect(await snapshot(ws, sys.id), `${sys.name} is unchanged`).toBe(before);
    }
  });

  it('without a choice, a pack\'s own database named like a system one is created SEPARATELY and the system one is untouched', async () => {
    const { ws, system } = await workspaceWithSystemDatabases();
    for (const sys of system) {
      const before = await snapshot(ws, sys.id);
      const res = await install(ws, packNamed(sys.name, `sys-name-${sys.name.toLowerCase().replace(/\W+/g, '-')}`));
      expect(res.statusCode, `${sys.name}: ${res.body}`).toBe(201);
      const made = (res.json().databases as Array<{ id: string; action: string }>)[0]!;
      expect(made.action).toBe('created');
      expect(made.id, 'not the system database').not.toBe(sys.id);
      const row = (await dbsOf(ws)).find((d) => d.id === made.id)!;
      expect(row.isSystem, 'an ordinary database').toBeFalsy();
      expect(await snapshot(ws, sys.id), `${sys.name} is unchanged: no pack field, no sample record`).toBe(before);
    }
  });

  it('installed INTO the space that holds a system database of that name: the pack still gets its own; the system one is untouched', async () => {
    const { ws, system } = await workspaceWithSystemDatabases();
    const members = system.find((d) => d.name === 'Members')!;
    const before = await snapshot(ws, members.id);
    const res = await install(ws, packNamed('Members', 'sys-members-into-its-space'), { target_space_id: members.spaceId });
    expect(res.statusCode, res.body).toBe(201);
    const made = (res.json().databases as Array<{ id: string; action: string }>)[0]!;
    expect(made.id).not.toBe(members.id);
    expect(await snapshot(ws, members.id)).toBe(before);
  });

  it('the preview never offers a system database: no collision, no existing_elsewhere, and a reuse choice does not make it adoptable', async () => {
    const { ws, system } = await workspaceWithSystemDatabases();
    for (const sys of system) {
      for (const extra of [{}, { target_space_id: sys.spaceId }, { resolutions: { [sys.name]: { action: 'reuse' } } }]) {
        const res = await preview(ws, packNamed(sys.name), extra);
        expect(res.statusCode, `${sys.name} ${JSON.stringify(extra)}: ${res.body}`).toBe(201);
        const item = res.json().databases[0] as { action: string; existing_elsewhere?: unknown };
        expect(item.action, 'a plain create').toBe('create');
        expect(item.existing_elsewhere, 'nothing points at a system database').toBeUndefined();
      }
    }
  });

  it('re-installing (an update) and uninstalling never touch the system database either', async () => {
    const { ws, system } = await workspaceWithSystemDatabases();
    const members = system.find((d) => d.name === 'Members')!;
    const before = await snapshot(ws, members.id);
    const manifest = packNamed('Members', 'sys-members-update');
    expect((await install(ws, manifest)).statusCode).toBe(201);
    expect((await install(ws, { ...manifest, version: '1.1.0' })).statusCode, 'the update').toBe(201);
    expect(await snapshot(ws, members.id)).toBe(before);
    const installed = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    const un = await as('POST', `/workspaces/${ws}/packs/${installed.find((i) => i.slug === manifest.slug)!.id}/uninstall`, {});
    expect(un.statusCode, un.body).toBeLessThan(300);
    expect((await dbsOf(ws)).some((d) => d.id === members.id), 'the system database is still there').toBe(true);
    expect(await snapshot(ws, members.id)).toBe(before);
  });
});
