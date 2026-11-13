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
          // the "advise how to proceed" shape that the first three patterns missed: "read the returned run rather than assuming", "say WHICH one when you have several"
          '\\b(?:read|say|name|state|tell|include|mention)\\b[^.;:!?]{0,50}\\b(?:rather than|when you have)\\b',
        ].join('|'),
        'i',
      ),
  },
  // Added after review of the first version (ticket #1288 send-back): that review found a dozen instructions the four patterns above passed,
  // because they only knew "call/use/run/read <tool>", sequencing words next to a tool NAME, and a few behaviour phrases. Each pattern
  // below is a SHAPE, not a list of the sentences that got through, and each is paired with a flags/passes self-test further down.
  {
    id: 'advice-idiom',
    why: 'idioms that advise the model what to reach for, when, or in what order ("reach for", "worth doing", "think before", "start from", "pass X first", "leave it off") are behaviour guidance, even with no tool name in them; state what the tool does or a fact instead',
    build: () =>
      new RegExp(
        [
          '\\breach(?:es)? for\\b',
          '\\bworth\\b',
          '\\bthink (?:before|twice|about)\\b',
          '(?:^|[.;!?\\u2014(]\\s*)(?:start|begin) (?:from|with|by)\\b',
          '\\bleave (?:it|this|that|them) (?:off|out|unset|empty|blank)\\b',
          // "Pass preview:true first", "list X first": an ordering instruction without a tool name. "newest first" and "first N" are facts.
          '\\b(?:pass|set|send|do|try|run|make|give|put|use|look|list|check|read)\\b[^.;!?]{0,40}(?<!newest )(?<!oldest )\\bfirst\\b(?!\\s+(?:\\d|n\\b|match|page|row|record|result|item|one|few|line|name|word|word|non|argument|key|value|element|occurrence))',
          // "pass distinct colours deliberately when building several", "use X when you ...": advice about how to choose.
          '\\b(?:pass|set|use|choose|pick|give)\\b[^.;:!?]{0,40}\\bdeliberately\\b',
          '\\b(?:pass|use|give|set|pick|choose|prefer|keep|avoid)\\b[^.;:!?]{0,60}\\bwhen (?:building|creating|writing|you)\\b',
          // "Use replace:true to ...", "use `workflow` (not `select`) for ...": an instruction about how to call THIS tool. A parameter note says what the parameter does ("replace:true sets ...").
          '(?:^|[.;!?\\u2014(]\\s*)use `?\\w+(?::\\s?(?:true|false)|`)',
        ].join('|'),
        'i',
      ),
  },
  {
    id: 'instead-or-rather-than-advice',
    why: 'an imperative clause ending in "instead" / "rather than <doing>" ("edit X instead", "name it in Y instead", "correct a mistake rather than posting") tells the model what to do in place of something else; state the fact ("a skill is deleted for everyone") instead',
    build: () =>
      new RegExp(
        [
          // "instead of" is a neutral comparison ("update instead of duplicate", "use instead of url" in a parameter note, "instead of adding to it")
          '\\b(?:edit|use|try|choose|pick|ask|send|create|name|pass|call)\\b[^.;:!?]{0,50}\\binstead\\b(?!\\s+of\\b)',
          '\\binstead,\\s+(?:name|use|pass|edit|call|try|ask|send)\\b',
          '\\b(?:correct|edit|use|prefer|pass|choose|pick|create|post|send|write|ask|read)\\b[^.;:!?]{0,60}\\brather than\\s+(?:\\w+ing|assuming|posting)\\b',
        ].join('|'),
        'i',
      ),
  },
  {
    id: 'imperative-clause-about-tool',
    why: 'a clause that starts with an imperative verb and sends the model to a tool ("Get the id from list_comments", "Pair it with get_credential", "Move a space into it with update_space_group") is an instruction about another tool; write "the id comes from list_comments" or "See also: X"',
    build: (t) =>
      new RegExp(
        // Not at position 0: a description's first verb is the tool's OWN action ("Read a record's thread ..."), which is what it must say.
        `(?<=[.;!?\\u2014]\\s+|\\()(?:so |then |and )?(?:get|pair|move|take|find|look|edit|open|combine|hand|feed|pass|attach|file|resolve|follow|go|send|put)\\b[^.;:!?]{0,60}\\b(?:from|with|into|via|in)\\s+\`?(?:${alt(t)})\\b`,
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
// An agent-run connection that names `tools=` extras is served ANY tool's WHOLE description (no lead, no pointer): the same text that is
// also get_started's TOOL NOTES section. Scanned separately below, as a ratchet, because that text still carries working guidance.
const wholeSurface = surfaceOf({ ...ADMIN, internal: true, wholeDescriptions: true });
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
  const names = ['get_started', 'describe_database', 'create_record', 'delete_record', 'restore_records', 'create_source', 'discover_source_fields', 'get_credential', 'list_comments', 'update_space', 'update_automation', 'get_history'];
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
    // ---- the survivors of the first version of this guard (ticket #1288 send-back), verbatim from the descriptions they came from ----
    ['Idempotent. Pass preview:true first to see, changing nothing, per database create / reuse / collision.', 'advice-idiom'],
    ['Show what would be created and create nothing. Worth doing first on a workspace that already has data.', 'advice-idiom'],
    ['meeting notes. Reach for this instead of inventing a database to hold one page of prose.', 'advice-idiom'],
    ['a content calendar. Reach for one before hand-building an ordinary shape.', 'advice-idiom'],
    ['for a database link; reach for this tool when you hold a view id.', 'advice-idiom'],
    ['Reach for this when the ORDER is the question.', 'advice-idiom'],
    ["Think before archiving on someone's behalf: it is their inbox.", 'advice-idiom'],
    ["or \"both\". Start from discover_source_fields' proposed_field_mapping.", 'advice-idiom'],
    ['Leave it off (the default) for an agent that should wake by itself.', 'advice-idiom'],
    ['Omit on create and one is random, so pass distinct colours deliberately when building several.', 'advice-idiom'],
    ['Worth setting deliberately after building several.', 'advice-idiom'],
    ['Starring is how a person finds something again, so this is worth doing after you build something.', 'advice-idiom'],
    ['Default ADDS links. Use replace:true to set the link set to exactly `targets`.', 'advice-idiom'],
    ['lookup/rollup/formula need config; use `workflow` (not `select`) for the one lifecycle status field.', 'advice-idiom'],
    ["If the goal is to stop it being suggested rather than to destroy it, edit its when_to_use instead.", 'instead-or-rather-than-advice'],
    ["To have an agent apply a skill instead, name it in that agent's Skills field.", 'instead-or-rather-than-advice'],
    ['Editing someone else\'s is refused — correct a mistake of your own rather than posting a second comment.', 'instead-or-rather-than-advice'],
    ['a runtime error lands as a Failed run, so read the returned run rather than assuming success.', 'instead-or-rather-than-advice'],
    ['Reuse an EXISTING database, and say WHICH one when you have several of that name.', 'model-behaviour'],
    ['Delete a comment you authored. Get the id from list_comments.', 'imperative-clause-about-tool'],
    ['Roll a record back. Get the version id from get_history with kind:"versions".', 'imperative-clause-about-tool'],
    ['Admin only. Pair it with get_credential: together they answer a question.', 'imperative-clause-about-tool'],
    ['Returns the rule. Feed the same shape back into update_automation.', 'imperative-clause-about-tool'],
    ['Add a presentational sidebar group. Move a space into it with update_space.', 'imperative-clause-about-tool'],
    ['Replace the text of a comment you authored (get its id from list_comments).', 'imperative-clause-about-tool'],
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
    // parameter documentation, and facts, that the widened patterns must KEEP (a guard that flags these would force vaguer descriptions)
    'Pass null to clear it.',
    'Omit for the overview and the index.',
    'Pass clear:true to unpin everything. Omit with clear:true.',
    'Base64-encoded file bytes (use instead of url).',
    'Replace the whole link set with `targets` instead of adding to it.',
    'Makes a re-sync update instead of duplicate.',
    'Moves holders onto this option instead of clearing them.',
    'Redirect here (an http:// or https:// address only) instead of showing success_message.',
    'Records come back newest first; the first 50 are returned.',
    'Run id (from get_runs).',
    'The version id comes from get_history with kind:"versions".',
    'The id comes from list_comments.',
    'Read a record\'s comment thread as plain text (id from list_comments).',
    'Edit a skill you own (id from list_skills).',
    'READ-ONLY, and deliberately: approving or rejecting is human-only.',
    'The default is false: the agent wakes by itself.',
    '`preview: true` reports, changing nothing, per database create / reuse / collision.',
    '`workflow` is the type of the one lifecycle status field a database is tracked by, whereas `select` is an ordinary choice field.',
    'A document is a page of prose; it is not a database and not the body of an unrelated record.',
    'Together with get_credential it answers "what could this token reach, and what did it do".',
    'update_automation accepts the same shape.',
    'A space joins it through update_space\'s `group` param.',
    'Shaped further with add_field and create_view.',
    'Omit on create and one is auto-assigned AT RANDOM, so databases created in a row can end up sharing a colour.',
    'It is the person\'s own inbox, and a notification archived by an agent is one they never saw.',
    'discover_source_fields returns a proposed_field_mapping in this shape.',
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

  /**
   * NOT a pass: a measured debt, pinned so it cannot grow unseen. The listed descriptions (above) are clean; the WHOLE descriptions of
   * the same tools (what an agent-run connection with `tools=` extras serves, and what get_started returns as TOOL NOTES <tool>) still
   * hold instructions ("Call get_field_usage first", "read it with get_skill first", "Use delegate_to_agent instead ...") in their tails.
   * Inside get_started that text is a tool RESULT, where guidance is allowed; as a description on a private Runner connection it is the
   * same class the directory policy forbids on the public listing. Fixing it means splitting each tool's description from its notes
   * (the notes keep the guidance, the description loses it), 46 tools at the time of writing (86 hits), which is its own change. Lower this number as tools are
   * split; do not raise it.
   */
  const WHOLE_DESCRIPTION_DEBT = 86;
  it('whole descriptions (agent-run tools= extras) carry no more instruction-style text than the measured baseline', () => {
    const hits = violationsIn(wholeSurface);
    expect(hits.length, `whole-description violations ${hits.length} > baseline ${WHOLE_DESCRIPTION_DEBT}; first: ${hits.slice(0, 5).join(' | ')}`).toBeLessThanOrEqual(WHOLE_DESCRIPTION_DEBT);
  });
});
