import { createSkillSchema } from '@storyos/schemas';
import type { CreateSkillInput } from '@storyos/schemas';

/**
 * #841 — import a SKILL.md (or one of our own Markdown exports) as a skill.
 *
 * THE REPORT IS THE REQUIREMENT; the parser is the easy half. Every piece of the incoming
 * file ends up in exactly one of two lists — KEPT (and which StoryOS field it landed in) or
 * DROPPED (and why) — so a person finds out what an import lost BEFORE the record exists,
 * not after. A silent discard fails this even if the parse is perfect. Nothing is invented
 * either: a field the file does not supply and the schema requires is reported as MISSING,
 * never filled with a guess.
 *
 * Pure: no database, no clock. The service decides whether to create.
 */

export interface ImportKept {
  field: string;
  from: string;
}
export interface ImportDropped {
  item: string;
  reason: string;
}
export interface ImportReport {
  kept: ImportKept[];
  dropped: ImportDropped[];
  /** Required StoryOS fields the file did not supply. The caller must provide them. */
  missing: string[];
  /** Schema problems with what WAS supplied (too long, empty...). */
  problems: string[];
}

export interface ParsedSkill {
  name?: string;
  description?: string;
  when_to_use?: string;
  instructions?: string;
  examples: Array<{ input: string; output: string }>;
}

/** The frontmatter keys StoryOS has a field for. Everything else is DROPPED, loudly. */
const FRONTMATTER_KEPT: Record<string, 'name' | 'description'> = { name: 'name', description: 'description' };

const DROP_REASONS: Record<string, string> = {
  'allowed-tools':
    'StoryOS has retired allowed-tools: nothing enforced it, because the model that follows a skill is always the reader\'s own.',
  allowed_tools:
    'StoryOS has retired allowed_tools: nothing enforced it, because the model that follows a skill is always the reader\'s own.',
  license: 'StoryOS skills have no license field.',
  compatibility: 'StoryOS skills have no compatibility field.',
  version: 'StoryOS skills have no version field.',
  metadata: 'StoryOS skills have no free-form metadata.',
};

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** A deliberately small frontmatter reader: flat `key: value` lines, plus indented/list
 *  continuation lines folded onto their key. Anything it cannot understand is still a KEY
 *  that gets reported as dropped, never skipped. */
function parseFrontmatter(raw: string): { entries: Array<[string, string]>; body: string } {
  const m = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { entries: [], body: raw };
  const entries: Array<[string, string]> = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) entries.push([kv[1]!, unquote(kv[2]!)]);
    else if (entries.length) entries[entries.length - 1]![1] += `${entries[entries.length - 1]![1] ? '\n' : ''}${line.trim()}`;
  }
  return { entries, body: m[2]! };
}

function parseExamples(section: string): Array<{ input: string; output: string }> {
  const out: Array<{ input: string; output: string }> = [];
  for (const block of section.split(/\*\*Example \d+\*\*/).slice(1)) {
    const m = block.match(/Input:\s*([\s\S]*?)\n\s*\nOutput:\s*([\s\S]*)$/);
    if (m) out.push({ input: m[1]!.trim(), output: m[2]!.trim() });
  }
  return out;
}

export function parseSkillMarkdown(raw: string): { parsed: ParsedSkill; report: Omit<ImportReport, 'problems'> } {
  const kept: ImportKept[] = [];
  const dropped: ImportDropped[] = [];
  const parsed: ParsedSkill = { examples: [] };

  const { entries, body } = parseFrontmatter(raw);
  for (const [key, value] of entries) {
    const target = FRONTMATTER_KEPT[key];
    if (target && value.trim()) {
      parsed[target] = value.trim();
      kept.push({ field: target, from: `frontmatter \`${key}\`` });
    } else {
      dropped.push({ item: `frontmatter \`${key}\``, reason: DROP_REASONS[key] ?? 'StoryOS has no field for this.' });
    }
  }

  // Body: split on level-2 headings. Text before the first one is the preamble.
  const parts = body.split(/^## +(.+?)\s*$/m);
  const preamble = parts[0]!.trim();
  const sections = new Map<string, string>();
  const order: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i]!.trim();
    sections.set(title.toLowerCase(), (sections.get(title.toLowerCase()) ?? '') + parts[i + 1]!);
    order.push(title);
  }

  // `# Title` is the name when the frontmatter did not supply one; either way it is accounted for.
  const h1 = preamble.match(/^# +(.+?)\s*$/m);
  let intro = preamble;
  if (h1) {
    if (!parsed.name) {
      parsed.name = h1[1]!.trim();
      kept.push({ field: 'name', from: 'the `# Title` heading' });
    } else {
      dropped.push({ item: 'the `# Title` heading', reason: 'A frontmatter name was already supplied; the heading was not used.' });
    }
    intro = preamble.replace(h1[0], '').trim();
  }

  // Two shapes. STRUCTURED is our own Markdown / SKILL.md export (`## When to use`,
  // `## Instructions`): each section lands in its own field and the intro paragraph is the
  // description. FREE-FORM is anyone else's SKILL.md: the whole body IS the procedure, and the
  // description can only come from the frontmatter — it is reported missing, not guessed.
  const structured = sections.has('instructions') || sections.has('when to use');
  const take = (title: string) => {
    const v = sections.get(title);
    sections.delete(title);
    return v?.trim() ? v.trim() : undefined;
  };

  if (structured) {
    if (intro && !parsed.description) {
      const [first, ...rest] = intro.split(/\n\s*\n/);
      parsed.description = first!.trim();
      kept.push({ field: 'description', from: 'the text before the first `##` heading' });
      if (rest.join('').trim()) dropped.push({ item: 'further introductory text', reason: `${rest.join('\n\n').trim().length} characters after the first paragraph have no field to land in.` });
    } else if (intro) {
      dropped.push({ item: 'introductory text', reason: 'A frontmatter description was already supplied; this text was not used.' });
    }
    const whenToUse = take('when to use');
    if (whenToUse) { parsed.when_to_use = whenToUse; kept.push({ field: 'when_to_use', from: '`## When to use`' }); }
    const instructions = take('instructions');
    if (instructions) { parsed.instructions = instructions; kept.push({ field: 'instructions', from: '`## Instructions`' }); }
    const examples = take('examples');
    if (examples) {
      parsed.examples = parseExamples(examples);
      if (parsed.examples.length) kept.push({ field: 'examples', from: `\`## Examples\` (${parsed.examples.length})` });
      else dropped.push({ item: '`## Examples`', reason: 'Could not read any "**Example N** / Input: / Output:" pair from it.' });
    }
    for (const title of order) {
      const key = title.toLowerCase();
      if (!sections.has(key)) continue;
      const text = sections.get(key)!.trim();
      sections.delete(key);
      dropped.push({
        item: `\`## ${title}\``,
        reason: key === 'allowed tools' ? DROP_REASONS['allowed_tools']! : `No StoryOS field for a "${title}" section (${text.length} characters).`,
      });
    }
  } else {
    const whole = [intro, ...order.map((t) => `## ${t}\n\n${(sections.get(t.toLowerCase()) ?? '').trim()}`)].filter(Boolean).join('\n\n').trim();
    if (whole) {
      parsed.instructions = whole;
      kept.push({ field: 'instructions', from: h1 ? 'the file body (below the title)' : 'the file body' });
    }
  }

  return { parsed, report: { kept, dropped, missing: [] } };
}

export interface ImportOverrides {
  name?: string;
  description?: string;
  when_to_use?: string;
  instructions?: string;
  visibility?: CreateSkillInput['visibility'];
}

/** Parse + merge caller overrides + validate. Never throws; everything is in the report. */
export function buildSkillImport(raw: string, overrides: ImportOverrides = {}) {
  const { parsed, report } = parseSkillMarkdown(raw);
  const kept = [...report.kept];
  const merged: Record<string, unknown> = { ...parsed };
  for (const field of ['name', 'description', 'when_to_use', 'instructions'] as const) {
    const v = overrides[field];
    if (v !== undefined && v.trim()) {
      merged[field] = v.trim();
      kept.push({ field, from: 'supplied with the import request' });
    }
  }
  if (overrides.visibility) merged.visibility = overrides.visibility;
  if (!parsed.examples.length) delete merged.examples;

  const missing = (['name', 'description', 'when_to_use', 'instructions'] as const).filter((f) => !String(merged[f] ?? '').trim());
  const problems: string[] = [];
  let input: CreateSkillInput | null = null;
  if (missing.length === 0) {
    const checked = createSkillSchema.safeParse(merged);
    if (checked.success) input = checked.data;
    else for (const issue of checked.error.issues) problems.push(`${issue.path.join('.') || 'skill'}: ${issue.message}`);
  }
  return { input, report: { kept, dropped: report.dropped, missing: [...missing], problems } satisfies ImportReport };
}
