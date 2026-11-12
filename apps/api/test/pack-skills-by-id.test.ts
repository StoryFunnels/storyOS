import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { parseSkillRefs } from '../src/skills/skill-refs';

/**
 * ticket #1110 — a pack agent follows its skills by ID, so renaming a skill never breaks the agent.
 *
 * Premise on main (origin/main a3845007): the Agents database's `skills` text is one NAME per line, and run time, pack update, export and
 * the Runner claim all match those names. Renaming a skill after install makes the agent's next run fail with skills.missing, and a pack
 * update (which also matches by name) creates a second copy of the skill.
 */
let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, admin.token, method, url, payload);

const SKILL = {
  name: 'Lead triage',
  description: 'How to triage a lead',
  when_to_use: 'When a lead is new',
  instructions: 'ALWAYS-ASK-BUDGET-FIRST then rank the lead A, B or C.',
  examples: [],
  allowed_tools: [],
};

/** What the skills API accepts today (`allowed_tools` is refused on a write, though a manifest still carries it). */
const { allowed_tools: _unused, ...API_SKILL } = SKILL;
void _unused;

const manifest = (slug: string, version = '1.0.0', goal = 'Triage new leads'): PackManifest =>
  ({
    format_version: 1,
    slug,
    name: `Pack ${slug}`,
    version,
    summary: 'A pack with one agent that uses one skill',
    scenario: 'pack',
    databases: [{ action: 'create', name: 'Leads', space: 'Sales', fields: [{ name: 'Company', type: 'text' }] }],
    relations: [],
    states: [{ database: 'Leads', field: 'Status', options: [{ label: 'New' }, { label: 'Triaged' }] }],
    agents: [{ name: 'Triage Agent', goal, scopes: ['read'], approval_policy: [], target_databases: ['Leads'], skills: [SKILL.name] }],
    triggers: [{ agent: 'Triage Agent', database: 'Leads', state_field: 'Status', state_option: 'New', human_gate: false }],
    views: [],
    automations: [],
    derived_fields: [],
    sample_records: [],
    skills: [SKILL],
    requires: { connections: [], ai: 'none' },
    license: 'All rights reserved',
  }) as unknown as PackManifest;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Skills By Id Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

async function workspace(label: string) {
  const ws = (await as('POST', '/workspaces', { name: label })).json().id as string;
  await as('POST', `/workspaces/${ws}/agents/ensure`);
  return ws;
}
const install = (ws: string, m: unknown) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: m });

interface Field { apiName: string; options?: Array<{ id: string; label: string }> }
async function dbByName(ws: string, name: string) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const db = dbs.find((d) => d.name === name)!;
  const detail = (await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json() as { fields: Field[] };
  return { id: db.id, fields: new Map(detail.fields.map((f) => [f.apiName, f])) };
}
const labelOf = (f: Field | undefined, id: unknown) => f?.options?.find((o) => o.id === id)?.label ?? null;

async function agentRecord(ws: string) {
  const agents = await dbByName(ws, 'Agents');
  const rows = (await as('POST', `/workspaces/${ws}/databases/${agents.id}/records/query`, { limit: 100 })).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
  return { ...rows.find((r) => r.title === 'Triage Agent')!, agentsDbId: agents.id };
}
const skillsIn = async (ws: string) => ((await as('GET', `/workspaces/${ws}/skills`)).json() as { data: Array<{ id: string; name: string }> }).data;
const renameSkill = async (ws: string, id: string, name: string) => expect((await as('PATCH', `/workspaces/${ws}/skills/${id}`, { name })).statusCode).toBe(200);

function textOf(blocks: unknown): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const b = node as { text?: unknown; content?: unknown; children?: unknown };
      if (typeof b.text === 'string') out.push(b.text);
      if (Array.isArray(b.content)) walk(b.content);
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ');
}
async function runAgent(ws: string, agentId: string) {
  const res = await as('POST', `/workspaces/${ws}/agents/${agentId}/run`);
  expect(res.statusCode, res.body).toBe(201);
  const run = res.json() as { values: Record<string, unknown> };
  const runs = await dbByName(ws, 'Runs');
  return { status: labelOf(runs.fields.get('status'), run.values.status), steps: textOf(run.values.steps) };
}
const setSkillsText = async (ws: string, agent: { id: string; agentsDbId: string }, text: string) =>
  expect((await as('PATCH', `/workspaces/${ws}/databases/${agent.agentsDbId}/records/${agent.id}`, { values: { skills: text } })).statusCode).toBe(200);

describe('the agent follows its skill by id (ticket #1110)', () => {
  it('install writes the skill id onto the agent line, and the label stays the manifest name', async () => {
    const ws = await workspace('Ids written');
    expect((await install(ws, manifest('ids-written'))).statusCode).toBe(201);
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    expect(parseSkillRefs((await agentRecord(ws)).values.skills)).toEqual([{ label: 'Lead triage', id: skill.id }]);
  }, 60_000);

  it('RENAME a skill after install: the next run still loads it', async () => {
    const ws = await workspace('Rename run');
    await install(ws, manifest('rename-run'));
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    await renameSkill(ws, skill.id, 'Lead triage v2');
    const run = await runAgent(ws, (await agentRecord(ws)).id);
    expect(run.status).toBe('Succeeded');
    expect(run.steps).toContain('skills.load');
    expect(run.steps).toContain(skill.id);
    expect(run.steps).not.toContain('skills.missing');
  }, 60_000);

  it('RENAME then a pack update: the update neither duplicates the skill nor drops it from the agent', async () => {
    const ws = await workspace('Rename update');
    await install(ws, manifest('rename-update'));
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    await renameSkill(ws, skill.id, 'Lead triage v2');
    const upd = await install(ws, manifest('rename-update', '1.1.0', 'Triage new leads, fast'));
    expect(upd.statusCode, upd.body).toBe(201);
    const after = await skillsIn(ws);
    expect(after.map((s) => s.name).sort()).toEqual(['Lead triage v2']);
    expect(after[0]!.id).toBe(skill.id);
    const agent = await agentRecord(ws);
    expect(parseSkillRefs(agent.values.skills).map((r) => r.id)).toEqual([skill.id]);
    expect((await runAgent(ws, agent.id)).status).toBe('Succeeded');
  }, 90_000);

  it('DELETE a skill: the agent reports it missing, and a different skill of the same name is NOT attached in its place', async () => {
    const ws = await workspace('Delete lookalike');
    await install(ws, manifest('delete-lookalike'));
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    expect((await as('DELETE', `/workspaces/${ws}/skills/${skill.id}`)).statusCode).toBe(200);
    const other = await as('POST', `/workspaces/${ws}/skills`, { ...API_SKILL, instructions: 'SOMEONE-ELSES-LOOKALIKE', visibility: 'shared' });
    expect(other.statusCode, other.body).toBe(201);
    const agent = await agentRecord(ws);
    const run = await runAgent(ws, agent.id);
    expect(run.status).toBe('Failed');
    expect(run.steps).toContain('skills.missing');
    expect(run.steps).toContain('Lead triage');
    // and an update does not adopt it either: the pack's own skill was deleted, so it is reported skipped, not swapped
    const upd = await install(ws, manifest('delete-lookalike', '1.1.0', 'Triage new leads, fast'));
    expect(upd.statusCode, upd.body).toBe(201);
    expect((upd.json() as { skills: Array<{ action: string }> }).skills.map((s) => s.action)).toEqual(['skipped']);
    expect(parseSkillRefs((await agentRecord(ws)).values.skills).map((r) => r.id)).toEqual([skill.id]);
    expect((await runAgent(ws, agent.id)).status).toBe('Failed');
  }, 90_000);

  it('two skills with the same name: the agent gets the one its line is linked to, not the one that now holds the name', async () => {
    const ws = await workspace('Same name');
    await install(ws, manifest('same-name'));
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    await renameSkill(ws, skill.id, 'Lead triage (old)');
    const mine = await as('POST', `/workspaces/${ws}/skills`, { ...API_SKILL, instructions: 'MY-OWN-SAME-NAMED-SKILL', visibility: 'personal' });
    expect(mine.statusCode, mine.body).toBe(201);
    const run = await runAgent(ws, (await agentRecord(ws)).id);
    expect(run.status).toBe('Succeeded');
    expect(run.steps).toContain(skill.id);
    expect(run.steps).not.toContain(mine.json().id);
  }, 60_000);

  it('a line with only a NAME (an agent from before this change) still resolves, and the id is recorded the first time it runs', async () => {
    const ws = await workspace('Name once');
    await install(ws, manifest('name-once'));
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    const agent = await agentRecord(ws);
    await setSkillsText(ws, agent, 'Lead triage'); // how every agent installed before #1110 is stored
    expect((await runAgent(ws, agent.id)).status).toBe('Succeeded');
    expect(parseSkillRefs((await agentRecord(ws)).values.skills)).toEqual([{ label: 'Lead triage', id: skill.id }]);
    await renameSkill(ws, skill.id, 'Lead triage v2');
    expect((await runAgent(ws, agent.id)).status).toBe('Succeeded');
  }, 90_000);

  it('a skill a person attached by hand is left alone by a pack update', async () => {
    const ws = await workspace('Hand attached');
    await install(ws, manifest('hand-attached'));
    const handmade = (await as('POST', `/workspaces/${ws}/skills`, { ...API_SKILL, name: 'My own habit', instructions: 'HABIT', visibility: 'personal' })).json().id as string;
    const agent = await agentRecord(ws);
    const before = String(agent.values.skills);
    await setSkillsText(ws, agent, `${before}\nMy own habit`);
    const upd = await install(ws, manifest('hand-attached', '1.1.0', 'Triage new leads, fast'));
    expect(upd.statusCode, upd.body).toBe(201);
    const refs = parseSkillRefs((await agentRecord(ws)).values.skills);
    expect(refs.map((r) => r.label)).toEqual(['Lead triage', 'My own habit']);
    expect(refs[1]!.id).toBeUndefined();
    expect(handmade).toBeTruthy();
  }, 90_000);
});

describe('export and re-install keep names, never ids (ticket #1110)', () => {
  it('a renamed skill exports under its CURRENT name, with no uuid in the manifest, and the export installs', async () => {
    const src = await workspace('Export src');
    await install(src, manifest('export-src'));
    const skill = (await skillsIn(src)).find((s) => s.name === SKILL.name)!;
    await renameSkill(src, skill.id, 'Lead triage v2');
    const exported = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'export-out', name: 'Out', version: '1.0.0', summary: 'x', space: 'Sales' });
    expect(exported.statusCode, exported.body).toBe(201);
    const out = exported.json() as { agents: Array<{ skills: string[] }>; skills: Array<{ name: string }> };
    expect(out.agents[0]!.skills).toEqual(['Lead triage v2']);
    expect(out.skills.map((s) => s.name)).toEqual(['Lead triage v2']);
    expect(JSON.stringify(out)).not.toContain(skill.id);
    expect(JSON.stringify(out)).not.toContain('[skill:');
    const dst = await workspace('Export dst');
    expect((await install(dst, out)).statusCode).toBe(201);
    const newSkill = (await skillsIn(dst)).find((s) => s.name === 'Lead triage v2')!;
    expect(parseSkillRefs((await agentRecord(dst)).values.skills)).toEqual([{ label: 'Lead triage v2', id: newSkill.id }]);
  }, 90_000);

  it('a manifest cannot carry a skill link by id', async () => {
    const ws = await workspace('Manifest link');
    const m = manifest('manifest-link');
    (m.agents[0] as { skills: string[] }).skills = ['Lead triage [skill:11111111-1111-4111-8111-111111111111]'];
    const res = await install(ws, m);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('skill link');
  }, 60_000);
});

describe("another member's personal skill is never attached (ticket #1110 / #1203)", () => {
  it('an id typed onto an agent that points at a colleague\'s personal skill resolves to nothing for a member owner', async () => {
    const ws = await workspace('Personal by id');
    await install(ws, manifest('personal-by-id'));
    const bob = await joinAs(app, admin.token, ws, 'Bob', 'member');
    const secret = (await call(app, bob.token, 'POST', `/workspaces/${ws}/skills`, { ...API_SKILL, name: 'Bobs secret', instructions: 'BOBS-PRIVATE-TEXT', visibility: 'personal' })).json().id as string;
    const agent = await agentRecord(ws);
    const mine = await call(app, bob.token, 'POST', `/workspaces/${ws}/databases/${agent.agentsDbId}/records`, { values: { name: 'Alices guess', enabled: true, skills: `x [skill:${secret}]` } });
    // whoever may create the agent, the skill is looked up as ITS owner sees skills: a member does not see Bob's personal skill
    expect([201, 403, 422]).toContain(mine.statusCode);
    const alice = await joinAs(app, admin.token, ws, 'Alice', 'member');
    const made = await call(app, alice.token, 'POST', `/workspaces/${ws}/databases/${agent.agentsDbId}/records`, { values: { name: 'Alice agent', enabled: true, skills: `x [skill:${secret}]` } });
    if (made.statusCode === 201) {
      const run = await call(app, alice.token, 'POST', `/workspaces/${ws}/agents/${made.json().id}/run`);
      const runs = await dbByName(ws, 'Runs');
      const body = run.statusCode === 201 ? textOf(run.json().values.steps) : run.body;
      expect(body).not.toContain('BOBS-PRIVATE-TEXT');
      if (run.statusCode === 201) expect(labelOf(runs.fields.get('status'), run.json().values.status)).toBe('Failed');
    }
  }, 120_000);

  it('a pack install never adopts a colleague\'s personal skill of the same name (an admin can LIST it)', async () => {
    const ws = await workspace('Personal adopt');
    const bob = await joinAs(app, admin.token, ws, 'Bob2', 'member');
    const secret = (await call(app, bob.token, 'POST', `/workspaces/${ws}/skills`, { ...API_SKILL, instructions: 'BOBS-PRIVATE-TEXT', visibility: 'personal' })).json().id as string;
    expect((await install(ws, manifest('personal-adopt'))).statusCode).toBe(201);
    const mineNow = (await skillsIn(ws)).filter((s) => s.name === SKILL.name && s.id !== secret);
    expect(mineNow).toHaveLength(1);
    expect(parseSkillRefs((await agentRecord(ws)).values.skills).map((r) => r.id)).toEqual([mineNow[0]!.id]);
  }, 90_000);
});
