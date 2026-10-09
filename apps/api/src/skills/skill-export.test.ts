import { describe, expect, it } from 'vitest';
import type { SkillSummary } from '@storyos/schemas';
import { renderSkillExport } from './skill-export';

const skill: SkillSummary = {
  id: 'id-1',
  workspace_id: 'ws-1',
  owner_id: 'user-1',
  visibility: 'shared',
  name: 'Weekly Status Digest!',
  description: 'Summarizes the week.',
  when_to_use: 'Every Friday, for a standing team update.',
  instructions: 'List records changed this week. Keep it under 200 words.',
  examples: [{ input: '10 records moved to Done', output: '10 done this week, 2 overdue.' }],
  source_template: 'weekly-digest',
  source: 'human',
  last_run_at: null,
  last_run_status: null,
  editable: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('renderSkillExport (#40 portable export)', () => {
  it('slugifies the filename and includes every section for markdown', () => {
    const out = renderSkillExport(skill, 'markdown');
    expect(out.filename).toBe('weekly-status-digest.md');
    expect(out.content).toContain('# Weekly Status Digest!');
    expect(out.content).toContain('## When to use');
    expect(out.content).toContain(skill.when_to_use);
    expect(out.content).toContain('## Instructions');
    expect(out.content).toContain(skill.instructions);
    expect(out.content).toContain('## Examples');
  });

  it('produces a SKILL.md with only name/description in frontmatter (Agent Skills convention)', () => {
    const out = renderSkillExport(skill, 'claude_skill');
    expect(out.filename).toBe('SKILL.md');
    // Slug drops punctuation ("!") — the frontmatter name is a clean identifier.
    expect(
      out.content.startsWith('---\nname: weekly-status-digest\ndescription: Summarizes the week.\n---'),
    ).toBe(true);
    expect(out.content).toContain('## Instructions');
  });

  it('produces plain-text ChatGPT custom instructions with a paste hint', () => {
    const out = renderSkillExport(skill, 'chatgpt');
    expect(out.filename).toBe('weekly-status-digest-chatgpt-instructions.txt');
    expect(out.content).toContain('When the request matches:');
    expect(out.content).toContain(skill.instructions);
    expect(out.content).toContain('Custom instructions');
  });

  it('omits the Examples section when a skill declares none', () => {
    const bare: SkillSummary = { ...skill, examples: [] };
    expect(renderSkillExport(bare, 'markdown').content).not.toContain('## Examples');
  });

  it('#841: allowed_tools is in NONE of the three renderers, even if an in-process caller passes one', () => {
    // The summary type no longer has the field, but packs hand the service a superset
    // internally — so assert on the OUTPUT, with the tool names present on the input.
    const smuggled = { ...skill, allowed_tools: ['records.read', 'databases.read'] } as SkillSummary;
    for (const format of ['markdown', 'claude_skill', 'chatgpt'] as const) {
      const out = renderSkillExport(smuggled, format).content;
      expect(out, format).not.toMatch(/allowed[ _-]tools/i);
      expect(out, format).not.toContain('records.read');
      expect(out, format).not.toContain('databases.read');
    }
  });
});
