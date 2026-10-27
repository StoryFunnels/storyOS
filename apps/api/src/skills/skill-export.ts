import type { SkillExport, SkillExportFormat, SkillSummary } from '@storyos/schemas';

/**
 * #40 — portable export (AC #2). Three renderers, all pure functions of a
 * `SkillSummary`: nothing here reaches into the database or the agent runtime,
 * because the entire point is that a skill means the same thing outside
 * StoryOS as inside it. Given the same skill, these always produce the same
 * text — which is what makes exporting, editing it in Claude/ChatGPT, and
 * re-importing it (by hand, today) a safe round trip.
 */

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

function examplesSection(skill: SkillSummary): string {
  if (skill.examples.length === 0) return '';
  const body = skill.examples
    .map((e, i) => `**Example ${i + 1}**\n\nInput: ${e.input}\n\nOutput: ${e.output}`)
    .join('\n\n');
  return `\n\n## Examples\n\n${body}`;
}

/** Plain Markdown — a standalone doc a person can read, or paste as a
 * system-prompt block into anything that accepts free text. */
function toMarkdown(skill: SkillSummary): SkillExport {
  const content =
    `# ${skill.name}\n\n${skill.description}\n\n## When to use\n\n${skill.when_to_use}\n\n` +
    `## Instructions\n\n${skill.instructions}` +
    examplesSection(skill) +
    '\n';
  return { format: 'markdown', filename: `${slugify(skill.name)}.md`, content };
}

/**
 * #1078 — a frontmatter value is user text inside YAML. Written raw, a newline in the description started a new
 * key (`allowed-tools: …` smuggled into a file another agent will load), and `: `, `#` or a leading quote broke the
 * parse. Plain text stays plain so ordinary exports read exactly as before; anything else becomes a JSON string,
 * which is also a valid YAML double-quoted scalar — every newline and quote inside it is an escape, never syntax.
 */
const YAML_SYNTAX = /[\p{Cc}\p{Zl}\p{Zp}:#"'\\`{}[\]|>&*!%@]/u;
/** Plain scalars a YAML reader would turn into a bool/null/number rather than the string we meant. */
const YAML_NON_STRING = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;
function yamlScalar(value: string): string {
  const plain =
    /^[\p{L}\p{N}]/u.test(value) && value === value.trimEnd() && !YAML_SYNTAX.test(value) && !YAML_NON_STRING.test(value);
  if (plain) return value;
  // JSON.stringify leaves NEL/LS/PS (and C1 controls) raw; YAML 1.1 and many line splitters treat them as breaks.
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The emerging Agent Skills on-disk convention: a `SKILL.md` whose YAML
 * frontmatter is exactly the two fields a skill picker matches a request
 * against (`name`, `description`) and whose body is everything else in plain
 * prose. Keeping frontmatter to those fields — rather than inventing
 * `when_to_use:` keys with no agreed meaning outside this repo — is what keeps
 * the file interoperable rather than StoryOS-specific. (#841: there is no
 * `allowed-tools` either; the model that follows a skill is the reader's own,
 * so nothing could enforce it.)
 */
function toClaudeSkill(skill: SkillSummary): SkillExport {
  const frontmatter = [
    '---',
    `name: ${slugify(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    // #841: the version travels with the skill, so an export/import round trip keeps it.
    `version: ${yamlScalar(skill.version)}`,
    '---',
  ].join('\n');
  const content =
    `${frontmatter}\n\n## When to use\n\n${skill.when_to_use}\n\n## Instructions\n\n${skill.instructions}` +
    examplesSection(skill) +
    '\n';
  return { format: 'claude_skill', filename: 'SKILL.md', content };
}

/** ChatGPT custom instructions are two free-text boxes ("What should ChatGPT
 * know about you" / "How should it respond") — this renders the single block
 * meant for the second box, with the rest folded in as prose since ChatGPT has
 * no separate "when to use" or "examples" fields of its own. */
function toChatGpt(skill: SkillSummary): SkillExport {
  const examples =
    skill.examples.length > 0
      ? `\n\nExamples of the kind of input/output this covers:\n${skill.examples
          .map((e) => `- Input: ${e.input}\n  Output: ${e.output}`)
          .join('\n')}`
      : '';
  const content =
    `When the request matches: ${skill.when_to_use}\n\n` +
    `Respond by following these instructions:\n${skill.instructions}` +
    examples +
    '\n\n(Paste this into Settings -> Personalization -> Custom instructions -> ' +
    '"How would you like ChatGPT to respond?")';
  return { format: 'chatgpt', filename: `${slugify(skill.name)}-chatgpt-instructions.txt`, content };
}

export function renderSkillExport(skill: SkillSummary, format: SkillExportFormat): SkillExport {
  switch (format) {
    case 'markdown':
      return toMarkdown(skill);
    case 'claude_skill':
      return toClaudeSkill(skill);
    case 'chatgpt':
      return toChatGpt(skill);
  }
}
