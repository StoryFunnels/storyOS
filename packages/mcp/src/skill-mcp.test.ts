import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSkillPrimitives } from './skill-mcp.js';
import type { Ctx } from './client.js';

/**
 * Skills as native MCP resources/prompts (#41) — this is the "portable resources"
 * half of the ticket, separate from the list_skills/run_skill tools in tools.ts.
 * These tests drive the real registerSkillPrimitives() against a fake client
 * (same fake-client convention as tools.test.ts), capturing whatever gets
 * registered on a fake McpServer, to prove: the resource catalog lists one entry
 * per visible skill across every workspace the token can see; reading one
 * resource returns the skill rendered as portable Markdown (the same shape
 * apps/api/src/skills/skill-export.ts's markdown renderer produces); one prompt
 * is registered per skill, named uniquely; and a workspace whose skills fail to
 * load never blanks out every other workspace's catalog.
 */

const WORKSPACE_A = { id: 'ws-a', name: 'Acme Co' };
const WORKSPACE_B = { id: 'ws-b', name: 'Beta Inc' };

const SKILL_DIGEST = {
  id: 'skill-1',
  name: 'Weekly Status Digest',
  description: 'Summarizes the week.',
  when_to_use: 'Every Friday, for a standing team update.',
  instructions: 'List records changed this week. Keep it under 200 words.',
  examples: [{ input: '10 records moved to Done', output: '10 done this week.' }],
  allowed_tools: ['records.read', 'databases.read'],
  visibility: 'shared',
  editable: true,
  source_template: 'weekly-digest',
};

const SKILL_TRIAGE = {
  id: 'skill-2',
  name: 'Lead Triage Reply',
  description: 'Drafts a first-touch reply.',
  when_to_use: 'A new lead lands.',
  instructions: 'Draft a friendly reply.',
  examples: [],
  allowed_tools: [],
  visibility: 'personal',
  editable: true,
  source_template: null,
};

interface FakeResourceEntry {
  name: string;
  template: ResourceTemplate;
  read: (uri: URL, variables: Record<string, string>, extra?: unknown) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>;
}
interface FakePromptEntry {
  name: string;
  config: { title?: string; description?: string };
  cb: () => Promise<{ description?: string; messages: Array<{ role: string; content: { type: string; text: string } }> }>;
}

function fakeServer() {
  const resources: FakeResourceEntry[] = [];
  const prompts: FakePromptEntry[] = [];
  const server = {
    registerResource: (name: string, template: unknown, _config: unknown, read: unknown) => {
      resources.push({ name, template: template as ResourceTemplate, read: read as never });
    },
    registerPrompt: (name: string, config: unknown, cb: unknown) => {
      prompts.push({ name, config: config as never, cb: cb as never });
    },
  } as unknown as McpServer;
  return { server, resources, prompts };
}

function fakeCtx(byWorkspace: Record<string, unknown[] | Error>) {
  const workspaces = Object.keys(byWorkspace).map((id) => (id === WORKSPACE_A.id ? WORKSPACE_A : id === WORKSPACE_B.id ? WORKSPACE_B : { id, name: id }));
  const GET = async (path: string, opts?: { params?: { path?: { ws?: string } } }) => {
    if (path === '/api/v1/workspaces') return { data: workspaces };
    if (path === '/api/v1/workspaces/{ws}/skills') {
      const ws = opts!.params!.path!.ws!;
      const entry = byWorkspace[ws];
      if (entry instanceof Error) throw entry;
      // SkillsController_list's real JSON body is `{ data: [...] }`, so the fake
      // client's own `{data, error}` envelope wraps that body directly.
      return { data: { data: entry ?? [] } };
    }
    throw new Error(`unmocked GET ${path}`);
  };
  return { client: { GET } as never, baseUrl: 'http://x', token: 't' } as Ctx;
}

async function readOne(entries: FakeResourceEntry[], workspaceId: string, skillId: string) {
  const entry = entries[0]!;
  const uri = new URL(`storyos-skill://${workspaceId}/${skillId}`);
  return entry.read(uri, { workspace: workspaceId, skill: skillId });
}

describe('registerSkillPrimitives — resources (#41)', () => {
  it('lists one resource per visible skill, across every workspace the token can see', async () => {
    const { server, resources } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_DIGEST], [WORKSPACE_B.id]: [SKILL_TRIAGE] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    expect(resources).toHaveLength(1); // one resource TEMPLATE registration…
    const list = await resources[0]!.template.listCallback!({} as never);
    // …covering both workspaces' skills as concrete listed entries.
    expect(list.resources.map((r) => r.uri).sort()).toEqual([
      `storyos-skill://${WORKSPACE_A.id}/${SKILL_DIGEST.id}`,
      `storyos-skill://${WORKSPACE_B.id}/${SKILL_TRIAGE.id}`,
    ].sort());
    expect(list.resources.find((r) => r.uri.includes(SKILL_DIGEST.id))?.name).toBe('Weekly Status Digest');
  });

  it('reads a resource back as the skill rendered as portable Markdown', async () => {
    const { server, resources } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_DIGEST] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    const result = await readOne(resources, WORKSPACE_A.id, SKILL_DIGEST.id);
    const text = result.contents[0]!.text;
    expect(result.contents[0]!.mimeType).toBe('text/markdown');
    expect(text).toContain('# Weekly Status Digest');
    expect(text).toContain('## When to use');
    expect(text).toContain(SKILL_DIGEST.when_to_use);
    expect(text).toContain('## Instructions');
    expect(text).toContain(SKILL_DIGEST.instructions);
    expect(text).toContain('## Examples');
    expect(text).toContain('## Allowed tools');
    expect(text).toContain('- records.read');
  });

  it('omits Examples/Allowed tools sections when the skill declares none', async () => {
    const { server, resources } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_TRIAGE] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    const result = await readOne(resources, WORKSPACE_A.id, SKILL_TRIAGE.id);
    expect(result.contents[0]!.text).not.toContain('## Examples');
    expect(result.contents[0]!.text).not.toContain('## Allowed tools');
  });

  it('throws a clear error reading an unknown workspace/skill pair', async () => {
    const { server, resources } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_DIGEST] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    await expect(readOne(resources, WORKSPACE_A.id, 'no-such-skill')).rejects.toThrow(/Unknown skill resource/);
  });

  it('a workspace whose skills fail to load never blanks out the rest of the catalog', async () => {
    const { server, resources } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: new Error('boom'), [WORKSPACE_B.id]: [SKILL_TRIAGE] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    const list = await resources[0]!.template.listCallback!({} as never);
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]!.name).toBe('Lead Triage Reply');
  });

  it('never throws out of registerSkillPrimitives even when listing workspaces itself fails', async () => {
    const server = fakeServer().server;
    const ctx = { client: { GET: async () => { throw new Error('down'); } } as never, baseUrl: 'http://x', token: 't' } as Ctx;
    await expect(registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true })).resolves.toBeUndefined();
  });
});

describe('registerSkillPrimitives — prompts (#41)', () => {
  it('registers one prompt per visible skill, returning the skill as a pasteable user message', async () => {
    const { server, prompts } = fakeServer();
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_DIGEST, SKILL_TRIAGE] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    expect(prompts).toHaveLength(2);
    const digestPrompt = prompts.find((p) => p.name.includes('weekly_status_digest'))!;
    expect(digestPrompt.config.title).toBe('Weekly Status Digest');
    const result = await digestPrompt.cb();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content.text).toContain('# Weekly Status Digest');
  });

  it('disambiguates two skills that would otherwise slugify to the same prompt name', async () => {
    const { server, prompts } = fakeServer();
    const dup = { ...SKILL_TRIAGE, id: 'skill-3', name: 'Weekly Status Digest' }; // same name, different workspace
    const ctx = fakeCtx({ [WORKSPACE_A.id]: [SKILL_DIGEST], [WORKSPACE_B.id]: [dup] });
    await registerSkillPrimitives(server, ctx, { scope: 'admin', allowRunButton: true });

    const names = prompts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length); // every name is unique
    expect(names).toContain('skill_weekly_status_digest');
    expect(names.some((n) => n.includes('beta_inc'))).toBe(true);
  });
});
