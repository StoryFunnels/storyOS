import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { blocksToMarkdown } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { packInstallItems, packInstalls } from '../src/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * #977 — a pack update RE-RUNS INSTALL, and a reused agent was matched by name and left untouched: a pack author who improved an agent's
 * instructions shipped an update that never reached anyone who already installed the pack, and the preview said only "Reuse existing".
 *
 * Product rule (Otto): never silently overwrite a person's work, and never silently skip an update.
 *   - an agent UNCHANGED since the pack installed it takes the update automatically, and the preview says so;
 *   - an agent the person EDITED is "edited, needs a choice": Keep mine (the default) or Take the update, with a diff;
 *   - an agent whose origin is UNKNOWN (installed before this was recorded) is treated as edited, so nothing is overwritten.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

const manifest = (slug: string, version: string, instructions: string, extra: Partial<PackManifest> = {}): PackManifest =>
  ({
    format_version: 1,
    slug,
    name: `Agent pack ${slug}`,
    version,
    summary: 'A pack with one agent',
    scenario: 'pack',
    databases: [{ action: 'create', name: 'Leads', space: 'Sales', fields: [{ name: 'Company', type: 'text' }] }],
    relations: [],
    states: [],
    agents: [{ name: 'Triage Agent', goal: 'Triage new leads', instructions, scopes: ['read'], approval_policy: [], target_databases: ['Leads'], skills: [] }],
    triggers: [],
    views: [],
    automations: [],
    derived_fields: [],
    sample_records: [],
    skills: [],
    requires: { connections: [], ai: 'none' },
    license: 'All rights reserved',
    ...extra,
  }) as unknown as PackManifest;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Agent Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

async function workspace(label: string) {
  const ws = (await as(admin.token, 'POST', '/workspaces', { name: label })).json().id as string;
  await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`);
  return ws;
}
const install = (ws: string, m: PackManifest, resolutions?: unknown, token = admin.token) =>
  as(token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: m, ...(resolutions ? { resolutions } : {}) });
const preview = async (ws: string, m: PackManifest) => {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/preview`, { manifest: m });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
async function agentRecord(ws: string, name = 'Triage Agent') {
  const dbs = (await as(admin.token, 'GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const agentsDb = dbs.find((d) => d.name === 'Agents')!.id;
  const rows = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${agentsDb}/records/query`, { limit: 100 })).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
  const rec = rows.find((r) => r.title === name)!;
  return { agentsDb, id: rec.id, instructions: blocksToMarkdown(rec.values.instructions ?? []).trim() };
}
const edit = async (ws: string, text: string) => {
  const a = await agentRecord(ws);
  const blocks = [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];
  const res = await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${a.agentsDb}/records/${a.id}`, { values: { instructions: blocks } });
  expect(res.statusCode, res.body).toBe(200);
};

describe('#977 REPRODUCTION: a pack update never reached an installed agent', () => {
  it('install v1, publish v2 with changed instructions, update: the agent still says v1 (this is the bug)', async () => {
    const ws = await workspace('977 Repro');
    expect((await install(ws, manifest('repro-pack', '1.0.0', 'Answer within one day.'))).statusCode).toBe(201);
    expect((await agentRecord(ws)).instructions).toBe('Answer within one day.');
    const v2 = manifest('repro-pack', '1.1.0', 'Answer within one hour, and tag every lead.');
    const pv = await preview(ws, v2);
    expect(pv.agents[0].agent_update?.status, 'the preview must say what the update does, not just "reuse"').toBe('will_update');
    expect((await install(ws, v2)).statusCode).toBe(201);
    expect((await agentRecord(ws)).instructions, 'the improved instructions must have arrived').toBe('Answer within one hour, and tag every lead.');
  });
});

const V1 = 'Answer within one day.';
const V2 = 'Answer within one hour, and tag every lead.';

describe('#977 an update reaches an installed agent according to who changed it', () => {
  it('UNMODIFIED: the preview says it will update, and install applies it', async () => {
    const ws = await workspace('977 Unmodified');
    await install(ws, manifest('um-pack', '1.0.0', V1));
    const pv = await preview(ws, manifest('um-pack', '1.1.0', V2));
    expect(pv.agents[0]).toMatchObject({ name: 'Triage Agent', action: 'reuse', agent_update: { status: 'will_update', changed_fields: ['instructions'], installed_version: '1.0.0' } });
    expect(pv.agents[0].agent_update.diff).toBeUndefined();
    const res = await install(ws, manifest('um-pack', '1.1.0', V2));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().agents[0]).toMatchObject({ name: 'Triage Agent', action: 'updated' });
    expect((await agentRecord(ws)).instructions).toBe(V2);
    // and the next update still classifies correctly: provenance moved to v1.1.0
    const again = await preview(ws, manifest('um-pack', '1.1.0', V2));
    expect(again.agents[0].agent_update).toMatchObject({ status: 'unchanged', installed_version: '1.1.0' });
    const v3 = await preview(ws, manifest('um-pack', '1.2.0', 'Third version.'));
    expect(v3.agents[0].agent_update.status).toBe('will_update');
  });

  it('MODIFIED: kept by default, the preview names the choice with a diff, and nothing is written', async () => {
    const ws = await workspace('977 Modified keep');
    await install(ws, manifest('mod-pack', '1.0.0', V1));
    await edit(ws, 'My own wording.');
    const v2 = manifest('mod-pack', '1.1.0', V2);
    const pv = await preview(ws, v2);
    const u = pv.agents[0].agent_update;
    expect(u).toMatchObject({ status: 'edited_needs_choice', reason: 'edited', changed_fields: ['instructions'] });
    expect(u.diff.instructions).toEqual([{ op: 'remove', text: 'My own wording.' }, { op: 'add', text: V2 }]);
    const res = await install(ws, v2); // no resolution: Keep mine, and NOT a 409 (the agent is not a collision)
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().agents[0].action).toBe('reused');
    expect((await agentRecord(ws)).instructions).toBe('My own wording.');
    // a kept agent is still "edited" next time: it did not silently become "matches the pack"
    expect((await preview(ws, manifest('mod-pack', '1.2.0', 'v3'))).agents[0].agent_update.status).toBe('edited_needs_choice');
  });

  it('MODIFIED: taking the update (resolution "update") overwrites it', async () => {
    const ws = await workspace('977 Modified take');
    await install(ws, manifest('take-pack', '1.0.0', V1));
    await edit(ws, 'My own wording.');
    const res = await install(ws, manifest('take-pack', '1.1.0', V2), { 'Triage Agent': { action: 'update' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().agents[0].action).toBe('updated');
    expect((await agentRecord(ws)).instructions).toBe(V2);
    expect((await preview(ws, manifest('take-pack', '1.1.0', V2))).agents[0].agent_update.status).toBe('unchanged');
  });

  it('UNKNOWN origin (installed before this was recorded) is treated as edited and never overwritten', async () => {
    const ws = await workspace('977 Legacy');
    await install(ws, manifest('legacy-pack', '1.0.0', V1));
    const [inst] = await raw.select().from(packInstalls).where(and(eq(packInstalls.workspaceId, ws), eq(packInstalls.slug, 'legacy-pack')));
    await raw.update(packInstallItems).set({ packVersion: null, sourceHash: null }).where(and(eq(packInstallItems.packInstallId, inst!.id), eq(packInstallItems.kind, 'agent')));
    const pv = await preview(ws, manifest('legacy-pack', '1.1.0', V2));
    expect(pv.agents[0].agent_update).toMatchObject({ status: 'edited_needs_choice', reason: 'unknown_origin' });
    expect((await install(ws, manifest('legacy-pack', '1.1.0', V2))).statusCode).toBe(201);
    expect((await agentRecord(ws)).instructions).toBe(V1);
  });

  it('a change to what the agent may DO (scopes) is listed, not applied silently when the agent was edited', async () => {
    const ws = await workspace('977 Scopes');
    await install(ws, manifest('scope-pack', '1.0.0', V1));
    const widened = manifest('scope-pack', '1.1.0', V1);
    (widened.agents[0] as { scopes: string[] }).scopes = ['read', 'write'];
    const pv = await preview(ws, widened);
    expect(pv.agents[0].agent_update.changed_fields).toEqual(['scopes']);
  });

  it('"update" is refused wherever it does not mean "take the pack\'s version of an edited agent"', async () => {
    const ws = await workspace('977 Refusals');
    await install(ws, manifest('ref-pack', '1.0.0', V1));
    const v2 = manifest('ref-pack', '1.1.0', V2);
    // unmodified agent: nothing to choose
    expect((await install(ws, v2, { 'Triage Agent': { action: 'update' } })).statusCode).toBe(422);
    // an unknown name
    expect((await install(ws, v2, { 'Nobody': { action: 'update' } })).statusCode).toBe(422);
    // the agent is untouched by the refused attempts
    expect((await agentRecord(ws)).instructions).toBe(V1);
  });

  it('a pack update is admin-only: a member cannot install or take an update', async () => {
    const ws = await workspace('977 Authz');
    await install(ws, manifest('authz-pack', '1.0.0', V1));
    const member = await joinAs(app, admin.token, ws, 'Pack Member', 'member');
    const res = await install(ws, manifest('authz-pack', '1.1.0', V2), undefined, member.token);
    expect([401, 403]).toContain(res.statusCode);
    expect((await agentRecord(ws)).instructions).toBe(V1);
  });

  it('writes provenance: version and source hash on created agents', async () => {
    const ws = await workspace('977 Provenance');
    await install(ws, manifest('prov-pack', '2.0.0', V1));
    const [inst] = await raw.select().from(packInstalls).where(and(eq(packInstalls.workspaceId, ws), eq(packInstalls.slug, 'prov-pack')));
    const rows = await raw.select().from(packInstallItems).where(and(eq(packInstallItems.packInstallId, inst!.id), eq(packInstallItems.kind, 'agent')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.packVersion).toBe('2.0.0');
    expect(rows[0]!.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
