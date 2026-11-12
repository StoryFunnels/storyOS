import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerTools } from './tools.js';
import { AGENT_RUN_BASE_TOOLS } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * ticket #1288 - the Claude connector directory policy for tool metadata: "tool descriptions contain no instructions about model
 * behavior, other tools, or external instruction sources". A description may say what THIS tool does, takes and returns, state a FACT
 * about the product ("a delete is held for approval when the agent's policy lists delete"), and carry a neutral REFERENCE
 * ("See also: describe_database", `[Full notes: get_started section "TOOL NOTES x"]`). It may not tell the model what to do with
 * another tool ("call describe_database first", "use X instead"), in which order to act, or how to behave ("ask the user", "never guess").
 * Behavioural guidance, where it is still wanted, lives in get_started's SECTION TEXT: that is a tool RESULT, not a description.
 *
 * Every pattern below is derived against the LIVE registry (registerTools against a recording server, every profile), over the tool
 * description AND every parameter description. A hand-copied list of names would pass for exactly the names it omits, and a scan of
 * descriptions only would pass for the parameter hints it never looked at.
 */

/** One pattern. `build` receives every live tool name so a reference to another tool is recognised by NAME, not by a guessed shape. */
export type PolicyPattern = { id: string; why: string; build: (toolNames: readonly string[]) => RegExp };

const alt = (names: readonly string[]): string => [...names].sort((a, b) => b.length - a.length).join('|');
const GAP = '[^.;:!?]{0,40}?';

export const FORBIDDEN_PATTERNS: readonly PolicyPattern[] = [
  {
    id: 'imperative-about-another-tool',
    why: 'an imperative verb followed by the name of a tool ("call X", "use X to", "read it with X") is an instruction about another tool; write "See also: X" instead',
    build: (t) => new RegExp(`\\b(?:call|invoke|run|use|using|fetch|try|prefer|read|check)\\b(?:\\s+(?:the|it|this|that|its|them|a|an|one))?(?:\\s+with)?\\s+\`?(?:${alt(t)})\\b|\\bpass (?:it|that|this|them) to\\s+(?:${alt(t)})\\b`, 'i'),
  },
  {
    id: 'tool-sequencing',
    why: 'ordering words around a tool name ("X first", "before X", "then X", "instead of X") sequence the model\'s calls; state the dependency as a fact or a "See also"',
    build: (t) =>
      new RegExp(
        `\\b(?:${alt(t)})\\b${GAP}\\b(?:first|afterwards|afterward|beforehand|instead)\\b|\\b(?:then|first|before|afterwards|instead of|rather than|prefer)\\b${GAP}\\b(?:${alt(t)})\\b`,
        'i',
      ),
  },
  {
    id: 'imperative-about-this-or-it',
    why: 'telling the model when to call this tool ("READ THIS before", "USE THIS FOR", "call first", "worth calling") is behaviour guidance',
    build: () => /\b(?:read|use|call|check|run) this\b|(?:^|[.;:!?(,\u2014]\s*)(?:so |then )?(?:read|use|call|check|run) it\b|\bcall first\b|\bworth (?:calling|checking)\b/i,
  },
  {
    id: 'model-behaviour',
    why: 'an instruction about how the model should behave ("ask the user", "never guess", "do not retry", "make sure", "say ...") belongs in get_started section text',
    build: () =>
      new RegExp(
        [
          "\\bask (?:the|a) (?:user|person|human)\\b",
          "(?:^|[.;!?\\u2014,]\\s+)tell (?:the|a) (?:user|person)\\b",
          '\\bconfirm with\\b',
          '\\bmake sure\\b',
          '\\bbe sure\\b',
          '\\bremember (?:to|that)\\b',
          "\\b(?:do not|don't|never) (?:guess|estimate|assume|recompute|retry|invent)\\b",
          '\\byou (?:must|should|need to|can ask|may want|might want)\\b',
          '\\btreat (?:it|this|that) as\\b',
          '\\bsay "',
          '\\bquote these\\b',
          '\\bshow the (?:list|plan|result)\\b',
          '\\bwrite it for\\b',
          '\\b(?:call|run|retry) (?:it |this )?again\\b',
          '\\b(?:read|check|look at|list|show|confirm|verify)\\b[^.;:!?]{0,50}(?<!newest )(?<!oldest )\\b(?:first|before (?:confirming|calling|using|writing|saving|creating|deleting|acting|installing|restoring))\\b',
          "(?:^|[.;!?\\u2014]\\s+)(?:do not|don't|avoid|prefer|remember)\\b",
        ].join('|'),
        'i',
      ),
  },
];

/**
 * Phrases proven neutral that a pattern would otherwise flag. Matched as an exact substring and blanked out BEFORE scanning, so an
 * entry can excuse only itself. Each needs a reason; keep this list small and prefer rewording a phrase to allow-listing it.
 */
export const ALLOWED_PHRASES: ReadonlyArray<{ text: string; reason: string }> = [];

export type PolicyViolation = { pattern: string; match: string };

export function findViolations(text: string, toolNames: readonly string[]): PolicyViolation[] {
  let scanned = text;
  for (const a of ALLOWED_PHRASES) scanned = scanned.split(a.text).join(' '.repeat(a.text.length));
  const found: PolicyViolation[] = [];
  for (const p of FORBIDDEN_PATTERNS) {
    const m = p.build(toolNames).exec(scanned);
    if (m) found.push({ pattern: p.id, match: scanned.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).replace(/\s+/g, ' ') });
  }
  return found;
}

// ---- the live registry, per profile -------------------------------------------------------------------------------------------------

const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
const ADMIN: EffectiveScope = { scope: 'admin', allowRunButton: true };

type Surface = Array<{ tool: string; where: string; text: string }>;

function collectDescriptions(node: unknown, path: string, out: Array<[string, string]>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (typeof n.description === 'string') out.push([path, n.description]);
  for (const [k, v] of Object.entries(n)) {
    if (k === 'description') continue;
    if (Array.isArray(v)) v.forEach((x, i) => collectDescriptions(x, `${path}.${k}[${i}]`, out));
    else collectDescriptions(v, `${path}.${k}`, out);
  }
}

/** Every tool description and every parameter description (nested ones too) a client of this profile is shown. */
function surfaceOf(effective: EffectiveScope): { surface: Surface; tools: string[] } {
  const surface: Surface = [];
  const tools: string[] = [];
  registerTools(
    {
      registerTool: (name: string, c: { description?: string; inputSchema?: unknown }) => {
        tools.push(name);
        surface.push({ tool: name, where: 'description', text: c.description ?? '' });
        const params: Array<[string, string]> = [];
        const schema = c.inputSchema && '_zod' in (c.inputSchema as object) ? (c.inputSchema as z.ZodType) : z.object((c.inputSchema ?? {}) as z.ZodRawShape);
        collectDescriptions(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), '', params);
        for (const [path, text] of params) surface.push({ tool: name, where: `parameter${path}`, text });
      },
    } as never,
    ctx,
    effective,
  );
  return { surface, tools };
}

const customer = surfaceOf(ADMIN);
const internal = surfaceOf({ ...ADMIN, internal: true });
const agentRun = surfaceOf({ ...ADMIN, onlyTools: new Set(AGENT_RUN_BASE_TOOLS), wholeDescriptions: true });
// Reference names come from the widest registry, so a customer description naming an internal-only tool is still recognised.
const ALL_TOOL_NAMES = internal.tools;

function violationsIn(s: { surface: Surface }): string[] {
  const out: string[] = [];
  for (const { tool, where, text } of s.surface) {
    for (const v of findViolations(text, ALL_TOOL_NAMES)) out.push(`${tool} ${where} [${v.pattern}]: ...${v.match}...`);
  }
  return out;
}

describe('ticket #1288 - the guard recognises what it must (self-tests)', () => {
  const names = ['get_started', 'describe_database', 'create_record', 'delete_record', 'restore_records'];
  const flagged = (text: string): string[] => findViolations(text, names).map((v) => v.pattern);

  it.each([
    ['call get_started first', 'imperative-about-another-tool'],
    ['values are keyed by api_name (call describe_database first)', 'imperative-about-another-tool'],
    ['Use delete_record for a single one.', 'imperative-about-another-tool'],
    ['Read this before restore_records (a deleted record no longer resolves).', 'imperative-about-this-or-it'],
    ['Prefer this over a sequence of create_record calls.', 'tool-sequencing'],
    ['Look the id up, then restore_records.', 'tool-sequencing'],
    ['Ask the user before you delete anything.', 'model-behaviour'],
    ["Never guess a count.", 'model-behaviour'],
    ['Quote these numbers, never estimate them.', 'model-behaviour'],
    ['fix and call again until valid', 'model-behaviour'],
    ['Read what the install covers first: it reaches the databases.', 'model-behaviour'],
    ['Refuses with a usage count unless confirmed; read that count before confirming.', 'model-behaviour'],
  ])('flags %j', (text, pattern) => {
    expect(flagged(text)).toContain(pattern);
  });

  it.each([
    '[Full notes: get_started section "TOOL NOTES create_record"]',
    'See also: describe_database (field types).',
    'See also: get_started section "FILTERS".',
    'Related: delete_record, restore_records.',
    'Deletes are held for approval when the agent\'s approval policy lists delete.',
    'Returns the version id that restore_records accepts.',
    'Whole-record snapshots; a version id goes to restore_version.',
    'tokens.used is null, never 0, when the runs\' tool reported no usage.',
    'Must be true; the guard exists because a title can resolve to the wrong database.',
    'Pass `clear: true` to remove the rule.',
  ])('passes %j', (text) => {
    expect(flagged(text)).toEqual([]);
  });

  it('every allow-list entry carries a reason and is not a pattern-sized catch-all', () => {
    for (const a of ALLOWED_PHRASES) {
      expect(a.reason.length, a.text).toBeGreaterThan(15);
      expect(a.text.length, a.text).toBeGreaterThan(8);
    }
  });
});

describe('ticket #1288 - no live tool or parameter description instructs the model (directory policy)', () => {
  it('covers the whole registry, descriptions AND parameter descriptions (so the scan is not a prefix of reality)', () => {
    expect(customer.tools.length).toBeGreaterThan(150);
    expect(customer.surface.filter((s) => s.where.startsWith('parameter')).length).toBeGreaterThan(300);
    expect(agentRun.tools.length).toBe(AGENT_RUN_BASE_TOOLS.length);
  });

  it('customer profile (default connection, listed leads and parameters)', () => {
    expect(violationsIn(customer)).toEqual([]);
  });

  it('internal profile', () => {
    expect(violationsIn(internal)).toEqual([]);
  });

  it('agent-run profile (descriptions kept whole)', () => {
    expect(violationsIn(agentRun)).toEqual([]);
  });
});
