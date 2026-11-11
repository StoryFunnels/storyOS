import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerTools } from './tools.js';
import { AGENT_RUN_BASE_TOOLS, AGENT_RUN_PROFILE, INTERNAL_PROFILE, resolveToolProfile } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * ticket #1262 - a pointer is a promise: "see get_started section='FILTERS'" is only true on a connection that can call get_started.
 * The agent-run profile (a Runner's runs) had no get_started while query_records' `filter` hint still said to call it, so an agent was
 * sent to a tool it could not call. Every profile is checked here from the LIVE registry (registerTools against a recording server,
 * with the same effective scope the HTTP server builds for that profile): every description AND every parameter description, nested
 * ones included. No hand-copied list of tools or sections: a new pointer, a new profile or a new tool is covered by being registered.
 */
const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
const ADMIN: EffectiveScope = { scope: 'admin', allowRunButton: true };

type Surface = { tools: Map<string, { description: string; params: string[] }>; started: (section?: string) => Promise<string> };

function surface(effective: EffectiveScope): Surface {
  const tools = new Map<string, { description: string; params: string[] }>();
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>>();
  registerTools(
    {
      registerTool: (n: string, c: { description?: string; inputSchema?: unknown }, h: never) => {
        const json = c.inputSchema && '_zod' in (c.inputSchema as object) ? z.toJSONSchema(c.inputSchema as never, { io: 'input', unrepresentable: 'any' }) : {};
        tools.set(n, { description: c.description ?? '', params: descriptionsIn(json) });
        handlers.set(n, h);
      },
    } as never,
    ctx,
    effective,
  );
  return { tools, started: async (section) => (await handlers.get('get_started')!(section === undefined ? {} : { section })).content[0]!.text };
}

/** Every `description` string anywhere in a JSON schema (properties, items, anyOf, nested objects). */
function descriptionsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptionsIn);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'description' && typeof v === 'string' ? [v] : descriptionsIn(v)));
}

/** The profile as the HTTP server builds it: resolveToolProfile's allowlist + whole-description flag, at the scope a run credential gets. */
function profileSurface(query: string, scope: EffectiveScope['scope'] = 'write'): Surface {
  const r = resolveToolProfile(new URLSearchParams(query));
  if (!r.ok) throw new Error(r.error);
  return surface({
    scope,
    allowRunButton: false,
    role: 'member',
    ...(r.allow ? { onlyTools: r.allow } : {}),
    ...(r.internal ? { internal: true } : {}),
    ...(r.wholeDescriptions ? { wholeDescriptions: true } : {}),
  });
}

const everyTool = [...surface({ ...ADMIN, internal: true }).tools.keys()];

const PROFILES: Array<[string, () => Surface]> = [
  ['customer (no profile, admin scope)', () => surface(ADMIN)],
  ['customer (no profile, write scope)', () => surface({ scope: 'write', allowRunButton: false, role: 'member' })],
  [INTERNAL_PROFILE, () => profileSurface(`profile=${INTERNAL_PROFILE}`, 'admin')],
  [AGENT_RUN_PROFILE, () => profileSurface(`profile=${AGENT_RUN_PROFILE}`)],
  [`${AGENT_RUN_PROFILE} + every other tool as an extra`, () => profileSurface(`profile=${AGENT_RUN_PROFILE}&tools=${everyTool.join(',')}`)],
];

// A pointer is `get_started` followed (within the same clause) by `section="X"` or `section='X'`.
const SECTION_POINTER = /get_started\b[^"'\n]{0,24}?section\s*=\s*(["'])(.+?)\1/g;

/** The index get_started returns on THIS profile: every non-empty line after the SECTIONS paragraph. */
async function indexOf(s: Surface): Promise<string[]> {
  const lines = (await s.started()).split('\n');
  const at = lines.findIndex((l) => l.startsWith('SECTIONS'));
  expect(at, 'get_started has an index').toBeGreaterThan(0);
  return lines.slice(at + 1).filter((l) => l.trim() !== '');
}

describe.each(PROFILES)('ticket #1262 - every pointer on the %s profile is true', (_name, build) => {
  const s = build();
  const texts = [...s.tools].flatMap(([tool, t]) => [{ where: `${tool} description`, text: t.description }, ...t.params.map((p) => ({ where: `${tool} parameter`, text: p }))]);

  it('is not an empty surface (the checks below are not walking nothing)', () => {
    expect(s.tools.size).toBeGreaterThanOrEqual(AGENT_RUN_BASE_TOOLS.length);
    expect(texts.length).toBeGreaterThan(s.tools.size);
  });

  it('a profile whose text mentions get_started offers get_started', () => {
    const mentioning = texts.filter((t) => /get_started/.test(t.text)).map((t) => t.where);
    if (mentioning.length > 0) expect(s.tools.has('get_started'), `these point at get_started, which this profile cannot call: ${mentioning.join('; ')}`).toBe(true);
  });

  it('every section a pointer names is in that profile\'s own get_started index', async () => {
    const pointers = texts.flatMap((t) => [...t.text.matchAll(SECTION_POINTER)].map((m) => ({ where: t.where, section: m[2]! })));
    if (pointers.length === 0) return;
    expect(s.tools.has('get_started'), 'a pointer exists but this profile has no get_started to answer it').toBe(true);
    const index = await indexOf(s);
    for (const p of pointers) expect(index, `${p.where} names section '${p.section}'`).toContain(p.section);
    // and the section answers (exact name): it returns text that is not the overview, never the "Unknown section" refusal
    const overview = await s.started();
    for (const section of new Set(pointers.map((p) => p.section))) {
      const text = await s.started(section);
      expect(text.length, section).toBeGreaterThan(0);
      expect(text, section).not.toBe(overview);
      expect(text, section).not.toMatch(/^Unknown section/);
    }
  });
});

describe('ticket #1262 - the pointer scan finds what it is meant to find', () => {
  it('sees the FILTERS pointer in query_records on the agent-run profile (so a green run is not an empty scan)', () => {
    const s = profileSurface(`profile=${AGENT_RUN_PROFILE}`);
    const q = s.tools.get('query_records')!;
    const all = [q.description, ...q.params].join('\n');
    expect([...all.matchAll(SECTION_POINTER)].map((m) => m[2])).toContain('FILTERS');
  });

  it('agent-run offers get_started and keeps every description whole', () => {
    const s = profileSurface(`profile=${AGENT_RUN_PROFILE}`);
    expect(s.tools.has('get_started')).toBe(true);
    for (const [tool, t] of s.tools) expect(t.description, tool).not.toContain('[Full notes: get_started');
  });
});
