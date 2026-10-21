import { describe, expect, it } from 'vitest';
import { groupingPatch } from './view-grouping';

describe('groupingPatch (#964)', () => {
  it('a NEW board shows empty columns: nothing is written for hide_empty_groups', () => {
    const p = groupingPatch({ viewType: 'board', config: {}, fieldId: 'f1', isDateField: false });
    expect(p.group_by_field_id).toBe('f1');
    expect('hide_empty_groups' in p).toBe(false);
  });

  it('a list grouped for the first time HIDES empty groups', () => {
    const p = groupingPatch({ viewType: 'list', config: {}, fieldId: 'f1', isDateField: false });
    expect(p.hide_empty_groups).toBe(true);
  });

  it('a view that already chose keeps its choice, either way', () => {
    expect('hide_empty_groups' in groupingPatch({ viewType: 'list', config: { hide_empty_groups: false }, fieldId: 'f1', isDateField: false })).toBe(false);
    expect('hide_empty_groups' in groupingPatch({ viewType: 'list', config: { hide_empty_groups: true }, fieldId: 'f1', isDateField: false })).toBe(false);
  });

  it('re-grouping an already grouped view never rewrites the empty-groups choice', () => {
    const p = groupingPatch({ viewType: 'list', config: { group_by_field_id: 'f0' }, fieldId: 'f1', isDateField: false });
    expect('hide_empty_groups' in p).toBe(false);
  });

  it('ungrouping to None clears the field and writes no empty-groups default', () => {
    const p = groupingPatch({ viewType: 'list', config: { group_by_field_id: 'f0' }, fieldId: '', isDateField: false });
    expect(p.group_by_field_id).toBeUndefined();
    expect('hide_empty_groups' in p).toBe(false);
  });

  it('a stale granularity is cleared when the new group field is not a date, kept off when it is', () => {
    expect(groupingPatch({ viewType: 'board', config: { group_by_field_id: 'd1' }, fieldId: 's1', isDateField: false })).toHaveProperty('group_by_granularity', undefined);
    expect('group_by_granularity' in groupingPatch({ viewType: 'board', config: { group_by_field_id: 'd1' }, fieldId: 'd2', isDateField: true })).toBe(false);
  });
});
