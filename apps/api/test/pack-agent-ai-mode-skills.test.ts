import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { AgentsService } from '../src/agents/agents.service';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { PACK_REGISTRY } from '../src/packs/registry';
import { AiCreditsService } from '../src/billing/ai-credits.service';
import { ManagedAiRuntime } from '../src/agents/agent-runtime';
import type { ManagedAiClient } from '../src/agents/managed-ai-client';

/**
 * ticket #1106 — a pack manifest sets an agent's AI mode, and the skills attached to a pack agent are loaded at RUN time.
 *
 * Premise on main: a manifest agent's `ai_mode` is stripped by the schema (so every pack agent installs with the AI mode unset, which
 * runs as Non-AI), and an agent's `skills` names are validated against the bundle and then thrown away — the Agents database has no
 * place to keep them, and no runtime reads them.
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

const manifest = (slug: string, agent: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): PackManifest =>
  ({
    format_version: 1,
    slug,
    name: `Pack ${slug}`,
    version: '1.0.0',
    summary: 'A pack with one AI agent',
    scenario: 'pack',
    databases: [{ action: 'create', name: 'Leads', space: 'Sales', fields: [{ name: 'Company', type: 'text' }] }],
    relations: [],
    states: [{ database: 'Leads', field: 'Status', options: [{ label: 'New' }, { label: 'Triaged' }] }],
    agents: [
      { name: 'Triage Agent', goal: 'Triage new leads', scopes: ['read'], approval_policy: [], target_databases: ['Leads'], skills: [], ...agent },
    ],
    triggers: [{ agent: 'Triage Agent', database: 'Leads', state_field: 'Status', state_option: 'New', human_gate: false }],
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
  admin = await signUpUser(app, 'Pack AI Mode Owner');
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

async function agentRecord(ws: string, name = 'Triage Agent') {
  const agents = await dbByName(ws, 'Agents');
  const rows = (await as('POST', `/workspaces/${ws}/databases/${agents.id}/records/query`, { limit: 100 })).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
  const rec = rows.find((r) => r.title === name)!;
  return { ...rec, aiMode: labelOf(agents.fields.get('ai_mode'), rec.values.ai_mode), agentsDbId: agents.id };
}

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
  return {
    status: labelOf(runs.fields.get('status'), run.values.status),
    runClass: labelOf(runs.fields.get('run_class'), run.values.run_class),
    steps: textOf(run.values.steps),
  };
}

describe('the manifest sets the agent AI mode (ticket #1106)', () => {
  it('installs a declared ai_mode onto the agent record', async () => {
    const ws = await workspace('Mode declared');
    const res = await install(ws, manifest('mode-declared', { ai_mode: 'your_own_ai' }));
    expect(res.statusCode, res.body).toBe(201);
    expect((await agentRecord(ws)).aiMode).toBe('Your own AI');
  }, 60_000);

  it('an omitted ai_mode leaves the agent exactly as it was before: the field stays unset', async () => {
    const ws = await workspace('Mode omitted');
    expect((await install(ws, manifest('mode-omitted'))).statusCode).toBe(201);
    expect((await agentRecord(ws)).aiMode).toBeNull();
  }, 60_000);

  it('an invalid ai_mode is a 422 that names the agent and the bad value', async () => {
    const ws = await workspace('Mode invalid');
    const res = await install(ws, manifest('mode-invalid', { ai_mode: 'turbo' }));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('Triage Agent');
    expect(res.body).toContain('ai_mode');
  }, 60_000);

  it('a run uses the declared mode and stamps its class at dispatch (a your-own-AI run is never metered)', async () => {
    const ws = await workspace('Mode run');
    await install(ws, manifest('mode-run', { ai_mode: 'your_own_ai' }));
    const agent = await agentRecord(ws);
    const entitlements = app.get(EntitlementsService);
    const can = vi.spyOn(entitlements, 'can');
    try {
      const run = await runAgent(ws, agent.id);
      expect(run.runClass).toBe('Your own AI');
      expect(can).not.toHaveBeenCalledWith(ws, 'automation_run');
    } finally {
      can.mockRestore();
    }
  }, 60_000);

  it('export round-trips the mode, and the exported manifest installs with it', async () => {
    const src = await workspace('Mode export src');
    expect((await install(src, manifest('mode-export', { ai_mode: 'storyos_ai' }))).statusCode).toBe(201);
    const exported = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'mode-export-out', name: 'Out', version: '1.0.0', summary: 'x', space: 'Sales' });
    expect(exported.statusCode, exported.body).toBe(201);
    const out = exported.json() as PackManifest;
    expect((out.agents[0] as { ai_mode?: string }).ai_mode).toBe('storyos_ai');

    const dst = await workspace('Mode export dst');
    expect((await install(dst, out)).statusCode).toBe(201);
    expect((await agentRecord(dst)).aiMode).toBe('StoryOS AI');
  }, 90_000);
});

describe('skills attached to a pack agent are loaded at run time (ticket #1106)', () => {
  const withSkill = (slug: string, agent: Record<string, unknown> = {}) =>
    manifest(slug, { skills: [SKILL.name], ...agent }, { skills: [SKILL] });

  async function skillsIn(ws: string) {
    const res = await as('GET', `/workspaces/${ws}/skills`);
    return (res.json() as { data: Array<{ id: string; name: string }> }).data;
  }

  it('install records which skills the agent uses, on the agent record', async () => {
    const ws = await workspace('Skills stored');
    expect((await install(ws, withSkill('skills-stored'))).statusCode).toBe(201);
    expect(String((await agentRecord(ws)).values.skills ?? '')).toContain('Lead triage');
  }, 60_000);

  it('the run record shows the skill that was loaded, with its instructions', async () => {
    const ws = await workspace('Skills in run');
    await install(ws, withSkill('skills-in-run'));
    const run = await runAgent(ws, (await agentRecord(ws)).id);
    expect(run.status).toBe('Succeeded');
    expect(run.steps).toContain('skills.load');
    expect(run.steps).toContain('Lead triage');
    expect(run.steps).toContain('ALWAYS-ASK-BUDGET-FIRST');
  }, 60_000);

  it('an edited skill is what the NEXT run uses (resolved at run time, not copied at install)', async () => {
    const ws = await workspace('Skills edited');
    await install(ws, withSkill('skills-edited'));
    const agent = await agentRecord(ws);
    expect((await runAgent(ws, agent.id)).steps).toContain('ALWAYS-ASK-BUDGET-FIRST');

    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    const patched = await as('PATCH', `/workspaces/${ws}/skills/${skill.id}`, { instructions: 'NOW-ASK-TIMELINE-FIRST.' });
    expect(patched.statusCode, patched.body).toBe(200);

    const after = (await runAgent(ws, agent.id)).steps;
    expect(after).toContain('NOW-ASK-TIMELINE-FIRST');
    expect(after).not.toContain('ALWAYS-ASK-BUDGET-FIRST');
  }, 60_000);

  it('a skill that no longer exists FAILS the run and names the skill, instead of running without it', async () => {
    const ws = await workspace('Skills removed');
    await install(ws, withSkill('skills-removed'));
    const agent = await agentRecord(ws);
    const skill = (await skillsIn(ws)).find((s) => s.name === SKILL.name)!;
    expect((await as('DELETE', `/workspaces/${ws}/skills/${skill.id}`)).statusCode).toBe(200);

    const run = await runAgent(ws, agent.id);
    expect(run.status).toBe('Failed');
    expect(run.steps).toContain('Lead triage');
    expect(run.steps).toMatch(/skills\.missing/);
    // Otto's ruling (b): it must say HOW to fix it, not just that it is missing.
    expect(run.steps).toContain('rename the skill back to "Lead triage"');
    expect(run.steps).toMatch(/re-attach/i);
  }, 60_000);

  it('a StoryOS-AI run puts the skill in the prompt the model reads', async () => {
    const ws = await workspace('Skills prompt');
    await install(ws, withSkill('skills-prompt', { ai_mode: 'storyos_ai' }));
    const agent = await agentRecord(ws);
    const complete = vi.fn<ManagedAiClient['complete']>().mockResolvedValue({
      text: JSON.stringify({ steps: [{ tool: 'note', summary: 'ok' }] }),
      tokensIn: 1,
      tokensOut: 1,
    });
    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    service.runtimeFor = () => new ManagedAiRuntime({ complete });
    // The managed runtime is credit-gated (MN-189); this workspace has no credits, so let the gate pass: the gate is not under test here.
    const credits = vi.spyOn(app.get(AiCreditsService), 'canUseManagedAi').mockResolvedValue(true);
    try {
      await runAgent(ws, agent.id);
    } finally {
      service.runtimeFor = original;
      credits.mockRestore();
    }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0]).toContain('ALWAYS-ASK-BUDGET-FIRST');
  }, 60_000);

  it('export bundles the skills an agent uses, so the exported pack installs', async () => {
    const src = await workspace('Skills export src');
    expect((await install(src, withSkill('skills-export'))).statusCode).toBe(201);
    const exported = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'skills-export-out', name: 'Out', version: '1.0.0', summary: 'x', space: 'Sales' });
    expect(exported.statusCode, exported.body).toBe(201);
    const out = exported.json() as PackManifest;
    expect(out.agents[0]!.skills).toEqual(['Lead triage']);
    expect(out.skills.map((s) => s.name)).toEqual(['Lead triage']);

    const dst = await workspace('Skills export dst');
    expect((await install(dst, out)).statusCode).toBe(201);
  }, 90_000);

  it('an agent with no skills runs exactly as before: no skills step', async () => {
    const ws = await workspace('No skills');
    await install(ws, manifest('no-skills'));
    const run = await runAgent(ws, (await agentRecord(ws)).id);
    expect(run.status).toBe('Succeeded');
    expect(run.steps).not.toContain('skills.load');
  }, 60_000);
});

describe('#977 pack updates still classify agents correctly now that mode and skills can be declared (ticket #1106)', () => {
  const preview = async (ws: string, m: unknown) => {
    const res = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().agents[0].agent_update as { status: string; changed_fields: string[] };
  };
  const v = (slug: string, version: string, agent: Record<string, unknown> = {}) => ({ ...manifest(slug, { instructions: 'v1 text', ...agent }), version });

  it('an agent whose mode a person set by hand is NOT reported as edited when the pack never declared a mode', async () => {
    const ws = await workspace('977 hand mode');
    await install(ws, v('hand-mode', '1.0.0'));
    const a = await agentRecord(ws);
    const agents = await dbByName(ws, 'Agents');
    const own = agents.fields.get('ai_mode')!.options!.find((o) => o.label === 'Your own AI')!.id;
    expect((await as('PATCH', `/workspaces/${ws}/databases/${a.agentsDbId}/records/${a.id}`, { values: { ai_mode: own } })).statusCode).toBe(200);

    const u = await preview(ws, v('hand-mode', '1.1.0', { instructions: 'v2 text' }));
    expect(u).toMatchObject({ status: 'will_update', changed_fields: ['instructions'] });
    expect((await install(ws, v('hand-mode', '1.1.0', { instructions: 'v2 text' }))).statusCode).toBe(201);
    expect((await agentRecord(ws)).aiMode, "the person's own choice survives the update").toBe('Your own AI');
  }, 60_000);

  it('an UNEDITED agent is NEVER switched to a newly declared mode on its own: the preview offers a choice, the rest still updates', async () => {
    const ws = await workspace('977 new mode');
    await install(ws, v('new-mode', '1.0.0'));
    const next = v('new-mode', '1.1.0', { instructions: 'v2 text', ai_mode: 'storyos_ai' });
    const u = await preview(ws, next);
    expect(u).toMatchObject({
      status: 'edited_needs_choice',
      reason: 'ai_mode',
      ai_mode_change: { current: null, proposed: 'storyos_ai' },
    });
    expect(u.changed_fields).toContain('ai_mode');

    // No resolution (Keep mine): the mode is not touched, but the untouched rest of the agent comes up to date.
    const kept = await install(ws, next);
    expect(kept.statusCode, kept.body).toBe(201);
    const after = await agentRecord(ws);
    expect(after.aiMode, 'storyos_ai must never be applied unasked').toBeNull();
    expect(textOf(after.values.instructions)).toContain('v2 text');
  }, 60_000);

  it('the person can TAKE the proposed mode in the update review (the same update resolution an edited agent uses)', async () => {
    const ws = await workspace('977 take mode');
    await install(ws, v('take-mode', '1.0.0'));
    const next = v('take-mode', '1.1.0', { ai_mode: 'storyos_ai' });
    const taken = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: next, resolutions: { 'Triage Agent': { action: 'update' } } });
    expect(taken.statusCode, taken.body).toBe(201);
    expect((await agentRecord(ws)).aiMode).toBe('StoryOS AI');
    expect(await preview(ws, next)).toMatchObject({ status: 'unchanged' });
  }, 60_000);

  it('the update resolution is still refused for an agent that needs no choice', async () => {
    const ws = await workspace('977 update refused');
    await install(ws, v('no-choice', '1.0.0'));
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: v('no-choice', '1.1.0', { instructions: 'v2 text' }), resolutions: { 'Triage Agent': { action: 'update' } } });
    expect(res.statusCode, res.body).toBe(422);
  }, 60_000);

  it("a newly declared mode never silently replaces the mode a person already chose: it needs a choice", async () => {
    const ws = await workspace('977 own mode vs declared');
    await install(ws, v('own-mode', '1.0.0'));
    const a = await agentRecord(ws);
    const agents = await dbByName(ws, 'Agents');
    const own = agents.fields.get('ai_mode')!.options!.find((o) => o.label === 'Your own AI')!.id;
    await as('PATCH', `/workspaces/${ws}/databases/${a.agentsDbId}/records/${a.id}`, { values: { ai_mode: own } });
    const next = v('own-mode', '1.1.0', { ai_mode: 'storyos_ai' });
    expect((await preview(ws, next)).status).toBe('edited_needs_choice');
    await install(ws, next);
    expect((await agentRecord(ws)).aiMode).toBe('Your own AI');
  }, 60_000);

  it('an EDITED agent is not overwritten by a newly declared mode: it needs a choice', async () => {
    const ws = await workspace('977 edited mode');
    await install(ws, v('edited-mode', '1.0.0'));
    const a = await agentRecord(ws);
    const blocks = [{ type: 'paragraph', content: [{ type: 'text', text: 'my words', styles: {} }] }];
    await as('PATCH', `/workspaces/${ws}/databases/${a.agentsDbId}/records/${a.id}`, { values: { instructions: blocks } });
    const next = v('edited-mode', '1.1.0', { ai_mode: 'storyos_ai' });
    expect((await preview(ws, next)).status).toBe('edited_needs_choice');
    await install(ws, next);
    expect((await agentRecord(ws)).aiMode, 'kept: nothing was written').toBeNull();
  }, 60_000);
});

describe('the built-in packs bring your own AI (ticket #1106, Otto ruling)', () => {
  const agents = PACK_REGISTRY.flatMap((e) => e.manifest.agents.map((a) => ({ pack: e.slug, agent: a })));

  it('there are built-in agents to check, and EVERY one declares your_own_ai', () => {
    expect(agents.length).toBeGreaterThan(0);
    const wrong = agents.filter((x) => (x.agent as { ai_mode?: string }).ai_mode !== 'your_own_ai').map((x) => `${x.pack}/${x.agent.name}`);
    expect(wrong).toEqual([]);
  });

  it('installing a built-in pack gives its agent Your own AI, and its run is stamped that and never metered', async () => {
    const entry = PACK_REGISTRY.find((e) => e.manifest.agents.length > 0)!;
    const ws = await workspace('Built-in mode');
    expect((await install(ws, entry.manifest)).statusCode).toBe(201);
    const agent = await agentRecord(ws, entry.manifest.agents[0]!.name);
    expect(agent.aiMode).toBe('Your own AI');
    const can = vi.spyOn(app.get(EntitlementsService), 'can');
    try {
      expect((await runAgent(ws, agent.id)).runClass).toBe('Your own AI');
      expect(can).not.toHaveBeenCalledWith(ws, 'automation_run');
    } finally {
      can.mockRestore();
    }
  }, 90_000);
});
