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

function toolsSection(skill: SkillSummary): string {
  if (skill.allowed_tools.length === 0) return '';
  return `\n\n## Allowed tools\n\n${skill.allowed_tools.map((t) => `- ${t}`).join('\n')}`;
}

/** Plain Markdown — a standalone doc a person can read, or paste as a
 * system-prompt block into anything that accepts free text. */
function toMarkdown(skill: SkillSummary): SkillExport {
  const content =
    `# ${skill.name}\n\n${skill.description}\n\n## When to use\n\n${skill.when_to_use}\n\n` +
    `## Instructions\n\n${skill.instructions}` +
    examplesSection(skill) +
    toolsSection(skill) +
    '\n';
  return { format: 'markdown', filename: `${slugify(skill.name)}.md`, content };
}

/**
 * The emerging Agent Skills on-disk convention: a `SKILL.md` whose YAML
 * frontmatter is exactly the two fields a skill picker matches a request
 * against (`name`, `description`) and whose body is everything else in plain
 * prose. Keeping frontmatter to those two fields — rather than inventing
 * `allowed_tools:`/`when_to_use:` keys with no agreed meaning outside this
 * repo — is what keeps the file interoperable rather than StoryOS-specific.
 */
function toClaudeSkill(skill: SkillSummary): SkillExport {
  const frontmatter = ['---', `name: ${slugify(skill.name)}`, `description: ${skill.description}`, '---'].join(
    '\n',
  );
  const content =
    `${frontmatter}\n\n## When to use\n\n${skill.when_to_use}\n\n## Instructions\n\n${skill.instructions}` +
    examplesSection(skill) +
    toolsSection(skill) +
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
