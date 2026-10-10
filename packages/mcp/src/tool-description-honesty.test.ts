import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

/**
 * #832 AC7 — a tool description is not documentation, it is instructions a model acts on.
 * Two of them told every connected AI to use an in-app Skills list and an in-app Run
 * button that do not exist; the agent relayed that to a person and then blamed its own
 * design. The two were written at different times by different people, so a convention
 * alone would not have held.
 *
 * THE MECHANISM, not a banned-phrase list: any sentence that CLAIMS a place in the app
 * ("in-app", "in the app", "in the UI", "app Inbox", "Settings → X", "press ... button")
 * must be backed by an entry below that names the claim AND a web path that must exist.
 * A claim with no entry fails; an entry whose path has been deleted fails too, so the
 * allowance cannot outlive the surface. To describe a new in-app place, build it first.
 */
const CLAIM =
  /\bin[- ]app\b|\bin the app\b|\bin the UI\b|\bapp (?:Inbox|[A-Z]\w+ page)\b|Settings\s*→\s*\w+|\bpress(?:ing)? (?:the )?"[^"]+"/gi;

const SURFACES: Array<{ tool: string; claim: RegExp; path: string; why: string }> = [
  { tool: 'list_approvals', claim: /app Inbox/i, path: 'apps/web/src/app/w/[ws]/inbox/page.tsx', why: 'approvals are decided in the Inbox' },
  { tool: 'create_skill', claim: /app Inbox/i, path: 'apps/web/src/app/w/[ws]/inbox/page.tsx', why: 'a public-skill approval (#867 AC3) is decided in the Inbox, like any approval' },
  { tool: 'update_skill', claim: /app Inbox/i, path: 'apps/web/src/app/w/[ws]/inbox/page.tsx', why: 'a public-skill approval (#867 AC3) is decided in the Inbox, like any approval' },
  { tool: 'get_runs', claim: /app Runs page/i, path: 'apps/web/src/app/w/[ws]/runs', why: 'failed actions are re-run from the Runs page' },
  { tool: 'list_connections', claim: /in the app|Settings\s*→\s*Connections/i, path: 'apps/web/src/app/w/[ws]/settings/connections', why: 'accounts are connected here' },
  { tool: 'create_source', claim: /Settings\s*→\s*Connections/i, path: 'apps/web/src/app/w/[ws]/settings/connections', why: 'accounts are connected here' },
  { tool: 'delete_webhook', claim: /made in the app/i, path: 'apps/web/src/app/w/[ws]/settings/webhooks/page.tsx', why: 'webhook subscriptions are created here' },
];

function descriptions(): Array<{ tool: string; text: string }> {
  const out: Array<{ tool: string; text: string }> = [];
  registerTools(
    { registerTool: (name: string, config: { description?: string }) => out.push({ tool: name, text: config.description ?? '' }) } as never,
    { client: {} as never, baseUrl: 'http://test', token: 'tok' },
  );
  return out;
}

describe('#832 AC7 — no tool description points at a surface that does not exist', () => {
  it('registers the full catalogue (guards against the scan silently covering nothing)', () => {
    const all = descriptions();
    expect(all.length).toBeGreaterThan(150);
    expect(all.map((d) => d.tool)).toEqual(expect.arrayContaining(['list_skills', 'run_skill', 'create_skill']));
  });

  it('every claim about an app surface is backed by a surface that exists', () => {
    const unbacked: string[] = [];
    for (const { tool, text } of descriptions()) {
      for (const m of text.matchAll(CLAIM)) {
        const entry = SURFACES.find((s) => s.tool === tool && s.claim.test(text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 40)));
        if (!entry) unbacked.push(`${tool}: "${m[0]}"`);
      }
    }
    expect(unbacked, 'a description claims an in-app place with no backing entry in SURFACES').toEqual([]);
  });

  it('every allowed surface still exists in apps/web', () => {
    for (const s of SURFACES) expect(existsSync(join(REPO, s.path)), `${s.tool}: ${s.path} (${s.why})`).toBe(true);
  });

  it('the skill tools say what they do and nothing about a Skills list or Run button', () => {
    const skill = descriptions().filter((d) => ['list_skills', 'run_skill', 'create_skill', 'update_skill'].includes(d.tool));
    expect(skill).toHaveLength(4);
    for (const { tool, text } of skill) {
      expect(text, tool).not.toMatch(/in[- ]app|Skills list|Run button|pressing/i);
    }
    // And run_skill keeps the BYO-AI contract unmissable (#832 AC4).
    const run = skill.find((d) => d.tool === 'run_skill')!.text;
    expect(run).toMatch(/YOU are the model/);
    expect(run).toMatch(/StoryOS executes nothing/);
  });

  it('#868 AC5: create_skill / update_skill descriptions match the visibility SCHEMA exactly (every accepted tier named, no tier claimed unavailable that the schema accepts)', () => {
    const cfgs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
    registerTools({ registerTool: (n: string, c: never) => void cfgs.set(n, c) } as never, {
      client: {} as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    type Arg = { safeParse: (v: unknown) => { success: boolean } };
    const ALL = ['personal', 'members', 'shared', 'public'];
    for (const tool of ['create_skill', 'update_skill']) {
      const cfg = cfgs.get(tool)!;
      const schema = cfg.inputSchema as unknown as { shape?: Record<string, Arg> } & Record<string, Arg>;
      const arg = (schema.shape ?? schema)['visibility']!;
      const accepted = ALL.filter((t) => arg.safeParse(t).success);
      // Every tier the schema accepts is named in the description (a model reads only the description).
      for (const tier of accepted) expect(cfg.description, `${tool} names \`${tier}\``).toContain(tier);
      // A tier the schema accepts is never described as not available.
      if (accepted.includes('members')) {
        expect(cfg.description, `${tool} must not say sharing with chosen people is unavailable`).not.toMatch(/chosen people (is|are) not|not available to AI|is not offered/i);
      }
      // And the argument that carries the people exists exactly when `members` is accepted.
      expect(Boolean((schema.shape ?? schema)['members']), `${tool} has a members argument iff the tier is accepted`).toBe(accepted.includes('members'));
    }
  });

  it('the guard can fail: it flags the exact sentence that misled the agent', () => {
    const bad = 'the same visibility rule the in-app Skills list enforces';
    expect([...bad.matchAll(CLAIM)].map((m) => m[0])).toEqual(['in-app']);
    const bad2 = 'same bookkeeping as pressing "Run" in-app';
    expect([...bad2.matchAll(CLAIM)].map((m) => m[0])).toEqual(['pressing "Run"', 'in-app']);
    // A button FIELD on a record is a product concept, not a claim about the UI.
    expect([...'Press a button field on a record'.matchAll(CLAIM)]).toHaveLength(0);
  });
});
