import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_OPTIONS } from '@storyos/schemas';
import { isUntouchedWorkflowSeed, optionsAfterTypeChange, seedWorkflowOptions } from './workflow-seed';

describe('#1151 — Add field pre-fills a new Workflow/Status field with the server default', () => {
  it('is the server constant exactly: same labels, colours and order', () => {
    expect(seedWorkflowOptions().map(({ label, color }) => ({ label, color }))).toEqual(
      DEFAULT_WORKFLOW_OPTIONS.map(({ label, color }) => ({ label, color })),
    );
  });

  it('gives each draft a distinct key', () => {
    const keys = seedWorkflowOptions().map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('choosing workflow with no options pre-fills; choosing it over typed options does not overwrite them', () => {
    expect(optionsAfterTypeChange('text', 'workflow', [])).toEqual(seedWorkflowOptions());
    const typed = [{ key: 0, label: 'Mine', color: 'red' }];
    expect(optionsAfterTypeChange('select', 'workflow', typed)).toBe(typed);
  });

  it('only workflow is pre-filled', () => {
    for (const t of ['select', 'multi_select', 'text']) expect(optionsAfterTypeChange('text', t, [])).toEqual([]);
  });

  it('leaving workflow drops an untouched pre-fill but KEEPS an edited one', () => {
    expect(optionsAfterTypeChange('workflow', 'select', seedWorkflowOptions())).toEqual([]);
    const edited = seedWorkflowOptions();
    edited[1] = { ...edited[1]!, label: 'Doing' };
    expect(optionsAfterTypeChange('workflow', 'select', edited)).toBe(edited);
    const removed = seedWorkflowOptions().slice(1);
    expect(optionsAfterTypeChange('workflow', 'select', removed)).toBe(removed);
  });

  it('treats a recoloured, reordered or extended pre-fill as touched', () => {
    const s = seedWorkflowOptions();
    expect(isUntouchedWorkflowSeed(s)).toBe(true);
    expect(isUntouchedWorkflowSeed([{ ...s[0]!, color: 'red' }, s[1]!, s[2]!])).toBe(false);
    expect(isUntouchedWorkflowSeed([s[1]!, s[0]!, s[2]!])).toBe(false);
    expect(isUntouchedWorkflowSeed([...s, { key: 9, label: 'More', color: 'red' }])).toBe(false);
  });
});
