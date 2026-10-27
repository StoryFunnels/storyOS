import { describe, expect, it } from 'vitest';
import { describeUnresolvedLabels, resolveOptionLabels } from '@storyos/schemas';

const fields = [
  { apiName: 'status', displayName: 'Status', type: 'select', options: [{ id: 'o-new', label: 'New' }, { id: 'o-done', label: 'Done' }] },
  { apiName: 'stage', displayName: 'Stage', type: 'workflow', options: [{ id: 'w-1', label: 'Todo' }, { id: 'w-2', label: 'Shipped' }] },
  { apiName: 'tags', displayName: 'Tags', type: 'multi_select', options: [{ id: 't-r', label: 'red' }, { id: 't-g', label: 'green' }] },
  { apiName: 'name', type: 'title' },
  { apiName: 'empty_select', type: 'select', options: [] },
];

describe('resolveOptionLabels (#719), shared by the MCP layer and the automation path', () => {
  it('resolves a label (any case) and keeps an id, for select, workflow and multi_select', () => {
    const { values, unresolved } = resolveOptionLabels(fields, { status: 'done', stage: 'w-2', tags: ['Red', 't-g'] });
    expect(values).toEqual({ status: 'o-done', stage: 'w-2', tags: ['t-r', 't-g'] });
    expect(unresolved).toEqual([]);
  });

  it('an unknown value is returned UNCHANGED and reported with the field name and every valid label', () => {
    const { values, unresolved } = resolveOptionLabels(fields, { status: 'Shipped', tags: ['red', 'purple'] });
    expect(values).toEqual({ status: 'Shipped', tags: ['t-r', 'purple'] });
    expect(unresolved).toEqual([
      { field: 'Status', given: 'Shipped', valid: ['New', 'Done'] },
      { field: 'Tags', given: 'purple', valid: ['red', 'green'] },
    ]);
    expect(describeUnresolvedLabels(unresolved)).toBe('"Status" has no option "Shipped". Valid options: New, Done. "Tags" has no option "purple". Valid options: red, green.');
  });

  it('leaves alone what it should: null, numbers, an empty string, other types, option-less fields and keys with no field', () => {
    const input = { status: null, stage: 5, tags: 'not-an-array', name: 'Done', empty_select: 'x', nothing: 'y' };
    const { values, unresolved } = resolveOptionLabels(fields, input);
    expect(values).toEqual(input);
    expect(unresolved).toEqual([]);
    expect(resolveOptionLabels(fields, { status: '' }).unresolved, 'an empty string is "nothing given", left to the validator').toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = { status: 'Done' };
    resolveOptionLabels(fields, input);
    expect(input).toEqual({ status: 'Done' });
  });
});
