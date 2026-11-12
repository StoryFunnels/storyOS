import { describe, expect, it } from 'vitest';
import { FILTERS_SECTION, ICONS_SECTION, SHORT_DESCRIPTION_CAP, WORKING_NOTES_SECTION, WORKING_NOTES_TEXT, registerTools, shortenDescription, toolNotesPointer, toolNotesSection } from './tools.js';
import { MCP_TOOL_NAMES } from '@storyos/schemas';
import { AGENT_RUN_PROFILE, resolveToolProfile } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * ticket #1262 (section) - get_started used to return ~85k characters in ONE result, and a client that truncates a single tool result
 * silently drops whatever is past its cut: the moved grammars. So get_started is now an overview + an INDEX (under 10k), and each piece of
 * reference text is its own section, fetched by exact name. Everything here is derived from the LIVE registry: a lead that points at a
 * section that does not exist, or a lead that is not a verbatim extract of the full text, fails here.
 */
const NO_SECTION_CAP = 10_000;
const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
const ADMIN: EffectiveScope = { scope: 'admin', allowRunButton: true };

function register(effective: EffectiveScope) {
  const descriptions = new Map<string, string>();
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>>();
  const notes = registerTools(
    {
      registerTool: (n: string, c: { description?: string }, h: never) => {
        descriptions.set(n, c.description ?? '');
        handlers.set(n, h);
      },
    } as never,
    ctx,
    effective,
  );
  const call = async (args: Record<string, unknown> = {}) => (await handlers.get('get_started')!(args)).content[0]!.text;
  return { descriptions, notes, call };
}
const reg = register(ADMIN);

/** The index: every non-empty line after the SECTIONS paragraph is one section name. */
async function indexNames(): Promise<string[]> {
  const lines = (await reg.call()).split('\n');
  const at = lines.findIndex((l) => l.startsWith('SECTIONS'));
  expect(at, 'the index starts at a SECTIONS line').toBeGreaterThan(0);
  return lines.slice(at + 1).filter((l) => l.trim() !== '');
}

const SENTENCE_SPLIT = /(?<!\be\.g|\bi\.e|\betc|\bvs|\bNo)(?<=[.!?])\s+(?=[A-Z"`(#{<[])/;
const stripPointer = (listed: string, tool: string) => listed.replace(toolNotesPointer(tool), '');
/** A lead is generated when it is exactly what shortenDescription makes of the full text (the other leads are hand-written). */
const generated = () => [...reg.notes].filter(([tool, full]) => stripPointer(reg.descriptions.get(tool)!, tool) === shortenDescription(full));

describe('get_started without a section: overview + index, short', () => {
  it(`is under ${NO_SECTION_CAP} characters and keeps the overview (what StoryOS is, the workflow, the agents paragraph)`, async () => {
    const text = await reg.call();
    expect(text.length).toBeLessThan(NO_SECTION_CAP);
    expect(text).toContain('StoryOS MCP');
    expect(text).toContain('READ:');
    expect(text).toContain('AGENTS: an agent is a record in the Agents database');
  });

  it('lists every section name, one per line, and they are the names `section` accepts', async () => {
    const names = await indexNames();
    expect(names).toContain(FILTERS_SECTION);
    expect(names).toContain(ICONS_SECTION);
    expect(names).toContain(WORKING_NOTES_SECTION);
    for (const tool of reg.notes.keys()) expect(names, tool).toContain(toolNotesSection(tool));
    expect(new Set(names).size, 'no duplicate names').toBe(names.length);
    expect(names.length).toBe(reg.notes.size + 3);
  });
});

describe('get_started with a section: that section and only that section', () => {
  it('every name in the index round-trips to non-empty text that is not the overview', async () => {
    const overview = await reg.call();
    for (const name of await indexNames()) {
      const text = await reg.call({ section: name });
      expect(text.trim().length, name).toBeGreaterThan(20);
      expect(text, name).not.toContain('SECTIONS');
      expect(text, name).not.toContain('Unknown section');
      expect(text.length, `${name} is one section, never the 85k`).toBeLessThan(40_000);
      expect(text, name).not.toBe(overview);
    }
  });

  it("a tool's section is that tool's full description, verbatim, headed by its name, and nothing of another tool", async () => {
    for (const [tool, full] of reg.notes) {
      expect(await reg.call({ section: toolNotesSection(tool) }), tool).toBe(`[${tool}]\n${full}`);
    }
  });

  it('the moved grammars are in their sections (key phrases)', async () => {
    const need: Record<string, RegExp[]> = {
      create_automation: [/TRIGGERS: /, /\{type:"record_created"\}/, /SEND EMAIL/, /CALL ANY HTTP API/, /POST TO SLACK/i],
      install_pack: [/reuse_databases/, /required_packs/, /existing_elsewhere/],
      add_field: [/formula/, /rollup/, /currency/],
      create_source: [/field_mapping/, /conflict_policy/, /write_back/, /external_key_field/],
    };
    for (const [tool, res] of Object.entries(need)) {
      const text = await reg.call({ section: toolNotesSection(tool) });
      expect(text.length, tool).toBeGreaterThan(1_000);
      for (const re of res) expect(text, `${tool}: ${re}`).toMatch(re);
    }
  });

  it('matches the exact name first, then case-insensitively', async () => {
    const exact = await reg.call({ section: 'TOOL NOTES create_automation' });
    expect(await reg.call({ section: 'tool notes CREATE_AUTOMATION' })).toBe(exact);
    expect(await reg.call({ section: '  icons ' })).toBe(await reg.call({ section: 'ICONS' }));
  });

  it('an unknown section is a clear text answer listing the valid names, never an exception and never the whole text', async () => {
    const text = await reg.call({ section: 'TOOL NOTES no_such_tool' });
    expect(text).toContain("Unknown section 'TOOL NOTES no_such_tool'");
    for (const name of await indexNames()) expect(text, name).toContain(name);
    expect(text.length).toBeLessThan(NO_SECTION_CAP);
    expect(text).not.toContain('TRIGGERS: ');
  });

  it('get_started itself is listed whole (not shortened) and says how to use `section`', () => {
    expect(reg.notes.has('get_started')).toBe(false);
    // ticket #1288: a description states what the tool does; the index/section mechanics are described, not commanded.
    expect(reg.descriptions.get('get_started')!).toContain('Without `section` it returns the overview and an index of section names; with `section` it returns one reference section');
    expect(reg.descriptions.get('get_started')!.length).toBeLessThanOrEqual(SHORT_DESCRIPTION_CAP);
  });

  it('a call with no arguments keeps working (additive change)', async () => {
    expect((await reg.call({})).length).toBeGreaterThan(0);
  });
});

describe('every lead points at the EXACT section that exists', () => {
  it('each shortened tool names its own section in its listed description, and every section it names is in the index', async () => {
    const names = new Set(await indexNames());
    expect(reg.notes.size).toBeGreaterThan(80);
    for (const tool of reg.notes.keys()) {
      const listed = reg.descriptions.get(tool)!;
      // ticket #1288: ONE canonical pointer, `[Full notes: get_started section "TOOL NOTES <tool>"]` (double quotes, no `=`).
      const named = [...listed.matchAll(/\[Full notes: get_started section "([^"]+)"\]/g)].map((m) => m[1]!);
      expect(named, `${tool}: the lead names a get_started section`).toContain(toolNotesSection(tool));
      for (const n of named) expect(names.has(n), `${tool}: lead points at '${n}', which is not a section`).toBe(true);
    }
  });

  it('no description or parameter text anywhere points at a get_started section that does not exist', async () => {
    const names = new Set(await indexNames());
    const cfgs: string[] = [];
    registerTools({ registerTool: (_n: string, c: unknown) => void cfgs.push(JSON.stringify(c)) } as never, ctx, ADMIN);
    const seen = new Set<string>();
    for (const c of cfgs) for (const m of c.matchAll(/get_started section \\"([^"\\]+)\\"/g)) seen.add(m[1]!);
    expect(seen.size).toBeGreaterThan(50);
    for (const n of seen) expect(names.has(n), `a description points at section '${n}'`).toBe(true);
  });

  it('a tool that was not shortened claims no notes', () => {
    for (const [tool, listed] of reg.descriptions) if (!reg.notes.has(tool)) expect(listed, tool).not.toContain('[Full notes: get_started');
  });

  it('the agent-run profile (get_started offered, whole descriptions) keeps every description whole and carries no notes pointer', () => {
    const r = resolveToolProfile(new URLSearchParams(`profile=${AGENT_RUN_PROFILE}`));
    if (!r.ok) throw new Error(r.error);
    const run = register({ scope: 'write', allowRunButton: false, role: 'member', onlyTools: r.allow, ...(r.wholeDescriptions ? { wholeDescriptions: true } : {}) });
    expect(run.notes.size).toBe(0);
    for (const [tool, d] of run.descriptions) {
      expect(d, tool).not.toContain('[Full notes: get_started');
      expect(reg.notes.get(tool) ?? reg.descriptions.get(tool), tool).toBe(d);
    }
  });
});

describe('the generated leads are truthful extracts of the full text', () => {
  it('there are generated leads to check (the check is not vacuous)', () => {
    expect(generated().length).toBeGreaterThan(70); // ticket #1288: was 80; a few descriptions got short enough (neutral rewording) to need no lead at all
  });

  it('each generated lead is whole sentences taken verbatim from the full description, and ends on a complete sentence', () => {
    for (const [tool, full] of generated()) {
      const lead = stripPointer(reg.descriptions.get(tool)!, tool);
      expect(lead.length, `${tool}: lead inside its cap (+ the call-time warnings)`).toBeLessThanOrEqual(SHORT_DESCRIPTION_CAP + 160 + 2 * 241);
      expect(lead, `${tool}: no mid-sentence cut`).toMatch(/[.!?"`)\]]$/);
      expect(lead, `${tool}: no ellipsis cut`).not.toContain('\u2026');
      const fullSentences = full.split(SENTENCE_SPLIT);
      const leadSentences = lead.split(SENTENCE_SPLIT);
      for (const sentence of leadSentences) {
        expect(fullSentences, `${tool}: "${sentence.slice(0, 60)}..." is not a verbatim sentence of the full text`).toContain(sentence);
      }
      expect(leadSentences[0], `${tool}: the lead opens with the full text's own first sentence`).toBe(fullSentences[0]);
    }
  });
});

describe('ticket #1288 - WORKING NOTES: where the behavioural guidance lives now (a tool RESULT, not a description)', () => {
  it('is a section of the index and returns its own text, not the overview', async () => {
    expect(await indexNames()).toContain(WORKING_NOTES_SECTION);
    const text = await reg.call({ section: WORKING_NOTES_SECTION });
    expect(text).toBe(WORKING_NOTES_TEXT);
    expect(text).not.toBe(await reg.call());
  });

  it('keeps the guidance that left the descriptions (reverting a move would drop one of these)', () => {
    expect(WORKING_NOTES_TEXT).toContain('use count_records for any "how many" question');
    expect(WORKING_NOTES_TEXT).toContain('describe_database returns the exact api_names');
    expect(WORKING_NOTES_TEXT).toContain('do not retry it');
    expect(WORKING_NOTES_TEXT).toContain('list_installed_packs before install_pack');
    expect(WORKING_NOTES_TEXT).toContain('quote them and never estimate');
  });

  it('every tool-shaped name in it is a real tool (a note that names a tool that does not exist is a promise nobody can keep)', () => {
    const real = new Set<string>(MCP_TOOL_NAMES);
    const shaped = [...new Set(WORKING_NOTES_TEXT.match(/\b(?:get|list|create|update|delete|restore|find|fix|run|preview|count|install|propose|build|remove|rerun|discover|sync)_[a-z_]+\b/g) ?? [])];
    expect(shaped.length).toBeGreaterThan(20);
    expect(shaped.filter((n) => !real.has(n))).toEqual([]);
  });
});
