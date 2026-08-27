import { describe, expect, it } from 'vitest';
import { isIncompleteCondition } from '@storyos/schemas';
import { activeFilterNode, buildFilterGroup, filterConditions } from './filter-config';
import type { FilterCondition, FilterNode } from './filter-config';

/**
 * #425 / #426 — what is BUILT, what is APPLIED, and what is KEPT are three
 * different things, and conflating any two of them is a bug that has now been
 * filed twice (#305 in dashboards, #345/#425 here).
 *
 *   built   — every condition in the builder, including half-finished ones
 *   applied — the subset complete enough to run (#345's rule)
 *   kept    — what persists, which must equal `built`, never `applied`
 *
 * The chip counts `built` and says "n · m applied" when the two differ. The
 * query sends `applied`. Persistence keeps `built`.
 */

const complete: FilterCondition = { field: 'name', op: 'contains', value: 'Tyron' };
const unfinished: FilterCondition = { field: 'epic', op: 'has_none', value: [] };
const valueless: FilterCondition = { field: 'due', op: 'is_empty' };
const disabled: FilterCondition = { field: 'name', op: 'contains', value: 'x', disabled: true };

describe('#425 — an unfinished condition is KEPT, not deleted', () => {
  it('survives the build → persist → read round trip', () => {
    // This is the assertion the ticket's report is about: build two, keep two.
    const group = buildFilterGroup('and', [complete, unfinished]);
    expect(filterConditions(group)).toHaveLength(2);
    expect(filterConditions(group)).toContainEqual(unfinished);
  });

  it('is excluded from the QUERY, so #345 does not regress', () => {
    const active = activeFilterNode(buildFilterGroup('and', [complete, unfinished]));
    // One survivor collapses out of its group — same rule as the backend.
    expect(active).toEqual({ field: 'name', op: 'contains', value: 'Tyron' });
  });

  it('never treats is_empty / not_empty as unfinished — they carry no value BY DESIGN', () => {
    expect(isIncompleteCondition(valueless)).toBe(false);
    expect(isIncompleteCondition({ op: 'not_empty' })).toBe(false);
    const active = activeFilterNode(buildFilterGroup('and', [valueless]));
    expect(active).toEqual({ field: 'due', op: 'is_empty' });
  });

  it('still tests emptiness explicitly, never by falsiness (#345)', () => {
    // The two values that a truthiness check would silently drop.
    expect(isIncompleteCondition({ op: 'eq', value: false })).toBe(false);
    expect(isIncompleteCondition({ op: 'eq', value: 0 })).toBe(false);
    const active = activeFilterNode(
      buildFilterGroup('and', [
        { field: 'done', op: 'eq', value: false },
        { field: 'count', op: 'eq', value: 0 },
      ]),
    );
    expect(active).toEqual({
      and: [
        { field: 'done', op: 'eq', value: false },
        { field: 'count', op: 'eq', value: 0 },
      ],
    });
  });
});

/**
 * #426 — the chip's arithmetic. Extracted as plain counting over the same tree
 * the toolbar renders, because the lie the ticket measured was numeric: two
 * conditions configured, "1 filter" displayed.
 */
function counts(nodes: FilterNode[]) {
  const leaves = nodes.filter((n): n is FilterCondition => !('and' in n || 'or' in n));
  const enabled = leaves.filter((n) => !n.disabled);
  return {
    configured: enabled.length,
    applied: enabled.filter((n) => !isIncompleteCondition(n)).length,
  };
}

describe('#426 — the count reflects what was built', () => {
  it('reports both numbers when a condition is not yet applied', () => {
    // The exact reported state: an Epic row with no value alongside a real one.
    expect(counts([complete, unfinished])).toEqual({ configured: 2, applied: 1 });
  });

  it('reports one number when everything is applied', () => {
    expect(counts([complete])).toEqual({ configured: 1, applied: 1 });
  });

  it('excludes disabled conditions from both counts', () => {
    // Disabled is a deliberate user action, not an unfinished one — it should
    // not inflate "configured" or read as something waiting to be fixed.
    expect(counts([complete, disabled])).toEqual({ configured: 1, applied: 1 });
  });

  it('counts a valueless operator as fully applied', () => {
    expect(counts([valueless])).toEqual({ configured: 1, applied: 1 });
  });
});
