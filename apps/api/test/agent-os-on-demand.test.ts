import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #1096 — the Agentic OS space and its Agents / Runs / Agent Triggers databases exist because SOMETHING NEEDS THEM. An
 * install that has no agent and no trigger must not leave them behind; the first agent, by any path, still provisions them.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let withAgents: { slug: string; manifest: Manifest };
let withoutAgents: { slug: string; manifest: Manifest };

interface Manifest { slug: string; name: string; databases: Array<{ name: string; space: string }>; agents?: unknown[] }

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const spaceNames = async (ws: string) => ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ name: string }>).map((s) => s.name);
const sysDbs = async (ws: string) =>
  ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; isSystem?: boolean; systemKey?: string | null }>).filter(
    (d) => d.systemKey === 'agents' || d.systemKey === 'agent_runs' || d.systemKey === 'agent_triggers',
  );
const install = (ws: string, manifest: unknown) => as('POST', `/workspaces/${ws}/packs/install`, { manifest });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'AgentOS Demand');
  const list = (await as('GET', '/packs/registry')).json() as { data?: Array<{ slug: string }> } | Array<{ slug: string }>;
  for (const { slug } of Array.isArray(list) ? list : list.data ?? []) {
    const manifest = ((await as('GET', `/packs/registry/${slug}`)).json() as { manifest?: Manifest }).manifest;
    if (!manifest) continue;
    if (manifest.agents?.length) withAgents ??= { slug, manifest };
    else withoutAgents ??= { slug, manifest };
  }
  expect(withAgents, 'the registry has a pack with agents').toBeTruthy();
  expect(withoutAgents, 'the registry has a pack without agents').toBeTruthy();
}, 180_000);
afterAll(async () => { await app.close(); });

describe('#1096 a pack with no agents and no triggers provisions no Agentic OS', () => {
  it('no target: no Agentic OS space and none of the three system databases', async () => {
    const ws = await newWs('No agents');
    const res = await install(ws, withoutAgents.manifest);
    expect(res.statusCode, res.body).toBe(201);
    expect(await spaceNames(ws)).not.toContain('Agentic OS');
    expect(await sysDbs(ws)).toEqual([]);
    expect((await as('GET', `/workspaces/${ws}/agents`)).json()).toEqual({ exists: false });
  });

  it('exporting a workspace that never had them reads, and provisions nothing', async () => {
    const ws = await newWs('Export no agents');
    expect((await install(ws, withoutAgents.manifest)).statusCode).toBe(201);
    const res = await as('POST', `/workspaces/${ws}/packs/export`, { slug: 'exp-no-agents', name: 'Exp', version: '1.0.0', space: withoutAgents.manifest.databases[0]!.space });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await spaceNames(ws)).not.toContain('Agentic OS');
    expect(await sysDbs(ws)).toEqual([]);
  });

  it('acting on an agent or run in a workspace without them is a 4xx and provisions nothing', async () => {
    const ws = await newWs('Ask without agents');
    for (const [method, url] of [
      ['POST', `/workspaces/${ws}/agents/1/run`],
      ['POST', `/workspaces/${ws}/agents/1/delegate`],
      ['GET', `/workspaces/${ws}/agents/1/activity`],
      ['POST', `/workspaces/${ws}/agents/runs/1/approve`],
      ['GET', `/workspaces/${ws}/agents/runs/1/staged`],
    ] as const) {
      const res = await as(method, url, method === 'POST' ? { record: '00000000-0000-0000-0000-000000000000' } : undefined);
      expect(res.statusCode, `${method} ${url}: ${res.statusCode} ${res.body}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${method} ${url} must not be a 5xx`).toBeLessThan(500);
    }
    expect(await spaceNames(ws)).not.toContain('Agentic OS');
    expect(await sysDbs(ws)).toEqual([]);
  });
});

describe('#1096 the first agent, by any path, still provisions them on demand', () => {
  it('a pack WITH agents provisions the space and all three databases', async () => {
    const ws = await newWs('With agents');
    const res = await install(ws, withAgents.manifest);
    expect(res.statusCode, res.body).toBe(201);
    expect(await spaceNames(ws)).toContain('Agentic OS');
    expect((await sysDbs(ws)).map((d) => d.systemKey).sort()).toEqual(['agent_runs', 'agent_triggers', 'agents']);
  });

  it('setup_agents (POST /agents/ensure) provisions them, and an agent record can then be created', async () => {
    const ws = await newWs('Ensure then create');
    expect(await sysDbs(ws)).toEqual([]);
    const ensured = await as('POST', `/workspaces/${ws}/agents/ensure`);
    expect(ensured.statusCode, ensured.body).toBe(201);
    const created = await as('POST', `/workspaces/${ws}/databases/${ensured.json().agentsDb.id}/records`, { values: { name: 'First agent' } });
    expect(created.statusCode, created.body).toBeLessThan(300);
    expect((await sysDbs(ws)).length).toBe(3);
  });
});

describe('#1096 a workspace that already has them is untouched', () => {
  it('installing packs and ensuring again creates no duplicates', async () => {
    const ws = await newWs('Already has');
    expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBe(201);
    const before = (await sysDbs(ws)).map((d) => d.id).sort();
    const spacesBefore = (await spaceNames(ws)).filter((n) => n === 'Agentic OS');
    expect((await install(ws, withoutAgents.manifest)).statusCode).toBe(201);
    expect((await install(ws, withAgents.manifest)).statusCode).toBe(201);
    expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).json().created).toBe(false);
    expect((await sysDbs(ws)).map((d) => d.id).sort()).toEqual(before);
    expect((await spaceNames(ws)).filter((n) => n === 'Agentic OS')).toEqual(spacesBefore);
  });
});
