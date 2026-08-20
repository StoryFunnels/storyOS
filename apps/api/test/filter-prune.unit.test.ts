import { describe, expect, it } from 'vitest';
import { activeFilter, isIncompleteCondition } from '@storyos/schemas';

/**
 * #345 — clearing the value out of a filter made every record disappear.
 *
 * The reported path was the view builder, but this prune walk is the SERVER-side
 * half of the same rule: it is what rollup filters (`records.service.ts`) and CSV
 * export (`export.service.ts`) run against a view's PERSISTED `filters`. A view is
 * saved with the unfinished condition still in it — deliberately, so the row stays
 * on screen while the user is mid-edit — so exporting that view hit exactly the
 * same compiler rejection the grid did.
 *
 * The two walks (here and `views/filter-config.ts`) previously had to be kept in
 * step by hand. They now share `isIncompleteCondition`; these tests pin the
 * behaviour on this side so a future edit to one cannot quietly diverge.
 */
describe('isIncompleteCondition (#345)', () => {
  it('calls an op that needs a value with no value UNFINISHED', () => {
    expect(isIncompleteCondition({ op: 'has_none', value: [] })).toBe(true);
    expect(isIncompleteCondition({ op: 'has', value: undefined })).toBe(true);
    expect(isIncompleteCondition({ op: 'eq', value: null })).toBe(true);
    expect(isIncompleteCondition({ op: 'contains', value: '' })).toBe(true);
  });

  it('does NOT call is_empty / not_empty unfinished — they carry no value by design', () => {
    expect(isIncompleteCondition({ op: 'is_empty', value: undefined })).toBe(false);
    expect(isIncompleteCondition({ op: 'not_empty', value: undefined })).toBe(false);
  });

  it('does NOT call falsy-but-real values unfinished', () => {
    // The obvious wrong implementation is a falsiness check, which deletes both of
    // these perfectly valid filters.
    expect(isIncompleteCondition({ op: 'eq', value: false })).toBe(false);
    expect(isIncompleteCondition({ op: 'eq', value: 0 })).toBe(false);
  });
});

describe('activeFilter drops unfinished conditions (#345)', () => {
  it('drops a cleared has_none, leaving nothing to run', () => {
    expect(activeFilter({ and: [{ field: 'status', op: 'has_none', value: [] }] })).toBeUndefined();
  });

  it('keeps the siblings of an unfinished condition', () => {
    expect(
      activeFilter({
        and: [
          { field: 'status', op: 'has_none', value: [] },
          { field: 'priority', op: 'eq', value: 'high' },
        ],
      }),
    ).toEqual({ field: 'priority', op: 'eq', value: 'high' });
  });

  it('still runs is_empty untouched', () => {
    expect(activeFilter({ and: [{ field: 'due', op: 'is_empty' }] })).toEqual({
      field: 'due',
      op: 'is_empty',
      value: undefined,
    });
  });

  it('still runs a checkbox-is-false filter', () => {
    expect(activeFilter({ and: [{ field: 'archived', op: 'eq', value: false }] })).toEqual({
      field: 'archived',
      op: 'eq',
      value: false,
    });
  });

  it('prunes through nesting, collapsing a group left with one child', () => {
    expect(
      activeFilter({
        and: [
          { field: 'priority', op: 'eq', value: 'high' },
          {
            or: [
              { field: 'status', op: 'has', value: [] },
              { field: 'owner', op: 'eq', value: 'u1' },
            ],
          },
        ],
      }),
    ).toEqual({
      and: [
        { field: 'priority', op: 'eq', value: 'high' },
        { field: 'owner', op: 'eq', value: 'u1' },
      ],
    });
  });

  it('still drops disabled conditions — the pre-existing rule is unchanged', () => {
    expect(
      activeFilter({
        and: [
          { field: 'a', op: 'eq', value: 'x', disabled: true },
          { field: 'b', op: 'eq', value: 'y' },
        ],
      }),
    ).toEqual({ field: 'b', op: 'eq', value: 'y' });
  });
});
