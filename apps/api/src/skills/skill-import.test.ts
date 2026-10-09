import { describe, expect, it } from 'vitest';
import type { SkillSummary } from '@storyos/schemas';
import { renderSkillExport } from './skill-export';
import { buildSkillImport, parseSkillMarkdown } from './skill-import';

/**
 * #841 — the KEPT/DROPPED report is the requirement. The property under test throughout:
 * every key and section in the incoming file is accounted for, in one list or the other.
 */
const skill: SkillSummary = {
  id: 'id-1', workspace_id: 'ws-1', owner_id: 'u-1', visibility: 'shared',
  name: 'Weekly Status Digest', description: 'Summarizes the week.',
  when_to_use: 'Every Friday, for a standing team update.',
  instructions: '1. List records changed this week.\n2. Keep it under 200 words.',
  examples: [{ input: '10 moved to Done', output: '10 done, 2 overdue.' }],
  version: '1.0.0', source_template: null, source: 'human', last_run_at: null, last_run_status: null, editable: true,
  created_at: '', updated_at: '',
};

const dropped = (r: { dropped: Array<{ item: string }> }) => r.dropped.map((d) => d.item);

describe('a SKILL.md from elsewhere: nothing is dropped silently', () => {
  const FOREIGN = `---
name: pdf-forms
description: Fill in PDF forms.
license: MIT
compatibility: claude-code
allowed-tools: Read Write Bash
version: 1.2.0
author: someone
---

# PDF forms

Use this when asked to fill a PDF.

## Steps

1. Read the form.
2. Fill it.

## Notes

Never guess a signature.
`;

  it('keeps name+description, treats the body as the procedure, and drops every unknown key BY NAME with a reason', () => {
    const { parsed, report } = parseSkillMarkdown(FOREIGN);
    expect(parsed.name).toBe('pdf-forms');
    expect(parsed.description).toBe('Fill in PDF forms.');
    expect(parsed.instructions).toContain('1. Read the form.');
    expect(parsed.instructions).toContain('Never guess a signature.'); // free-form: the whole body is the procedure
    // `version` is semver here, so it is KEPT (#841), not dropped.
    expect(parsed.version).toBe('1.2.0');
    expect(report.kept).toContainEqual({ field: 'version', from: '`version` frontmatter' });
    for (const key of ['license', 'compatibility', 'allowed-tools', 'author']) {
      expect(dropped(report), key).toContain(`frontmatter \`${key}\``);
    }
    expect(report.dropped.find((d) => d.item.includes('allowed-tools'))!.reason).toMatch(/retired/i);
    expect(dropped(report)).toContain('the `# Title` heading'); // name came from the frontmatter
    // Accounting: every frontmatter key is in exactly one list.
    const seen = [...report.kept.map((k) => k.from), ...dropped(report)].join(' ');
    for (const key of ['name', 'description', 'license', 'compatibility', 'allowed-tools', 'author']) expect(seen, key).toContain(`\`${key}\``);
    expect(seen).toContain('version');
  });

  it('a version that is not semver is DROPPED by name with the reason, never coerced', () => {
    const r = buildSkillImport('---\nname: x\ndescription: d\nversion: v2\n---\n\nBody.\n', { when_to_use: 'w' });
    expect(r.report.dropped.map((d) => d.item)).toContain('frontmatter `version`');
    expect(r.report.dropped.find((d) => d.item.includes('version'))!.reason).toMatch(/not semver/);
    expect(r.input!.version).toBeUndefined();
  });

  it('a file with no when_to_use is reported MISSING, never filled with a guess', () => {
    const r = buildSkillImport(FOREIGN);
    expect(r.input).toBeNull();
    expect(r.report.missing).toEqual(['when_to_use']);
  });

  it('...and importable once the caller supplies it, with that recorded as the source', () => {
    const r = buildSkillImport(FOREIGN, { when_to_use: 'When asked to fill a PDF form.' });
    expect(r.report.missing).toEqual([]);
    expect(r.input).toMatchObject({ name: 'pdf-forms', when_to_use: 'When asked to fill a PDF form.' });
    expect(r.report.kept).toContainEqual({ field: 'when_to_use', from: 'supplied with the import request' });
  });

  it('a field over its limit is a PROBLEM in the report, not a thrown error', () => {
    const r = buildSkillImport(FOREIGN, { when_to_use: 'x'.repeat(1001) });
    expect(r.input).toBeNull();
    expect(r.report.problems.join(' ')).toMatch(/when_to_use/);
  });

  it('an empty file yields every required field missing, and still does not throw', () => {
    const r = buildSkillImport('');
    expect(r.report.missing).toEqual(['name', 'description', 'when_to_use', 'instructions']);
  });
});

describe('our own export round-trips', () => {
  it('Markdown export: every field comes back, nothing dropped', () => {
    const r = buildSkillImport(renderSkillExport(skill, 'markdown').content);
    expect(r.report.dropped).toEqual([]);
    expect(r.input).toMatchObject({
      name: 'Weekly Status Digest',
      description: 'Summarizes the week.',
      when_to_use: skill.when_to_use,
      instructions: skill.instructions,
      examples: skill.examples,
    });
  });

  it('SKILL.md export: the name comes back as the frontmatter slug, and nothing else is lost', () => {
    const r = buildSkillImport(renderSkillExport(skill, 'claude_skill').content);
    expect(r.report.dropped).toEqual([]);
    expect(r.input).toMatchObject({ name: 'weekly-status-digest', when_to_use: skill.when_to_use, instructions: skill.instructions, examples: skill.examples });
  });

  it('a file exported by an OLDER StoryOS still carries `## Allowed tools`: dropped by name, with the reason', () => {
    const old = `${renderSkillExport(skill, 'markdown').content}\n## Allowed tools\n\n- records.read\n`;
    const r = buildSkillImport(old);
    expect(dropped(r.report)).toEqual(['`## Allowed tools`']);
    expect(r.report.dropped[0]!.reason).toMatch(/retired/i);
    expect(r.input!.instructions).not.toContain('records.read');
  });

  it('an unknown section in a structured file is dropped with its size, not folded in silently', () => {
    const r = buildSkillImport(`${renderSkillExport(skill, 'markdown').content}\n## Changelog\n\nv1 shipped.\n`);
    expect(dropped(r.report)).toEqual(['`## Changelog`']);
    expect(r.report.dropped[0]!.reason).toMatch(/Changelog/);
  });
});
