import { describe, expect, it } from 'vitest';
import {
  activeFilterNode,
  buildFilterGroup,
  filterConditions,
  filterConnector,
  reorderConditions,
} from './filter-config';
import type { FilterCondition } from './filter-config';

/**
 * MN-253: the filtering overhaul's pure logic — And/Or connector round-tripping,
 * disabled clauses dropping out of the executed query, drag-reorder, and pin/label/
 * icon surviving a round trip through the persisted FilterGroup shape.
 */

const cond = (over: Partial<FilterCondition>): FilterCondition => ({
  field: 'state',
  op: 'eq',
  value: 'done',
  ...over,
});

describe('filterConnector / filterConditions', () => {
  it('reads "and" as the connector for an {and:[...]} group', () => {
    const group = { and: [cond({})] };
    expect(filterConnector(group)).toBe('and');
    expect(filterConditions(group)).toEqual([cond({})]);
  });

  it('reads "or" as the connector for an {or:[...]} group', () => {
    const group = { or: [cond({})] };
    expect(filterConnector(group)).toBe('or');
    expect(filterConditions(group)).toEqual([cond({})]);
  });

  it('defaults to "and" and an empty list when there is no filter', () => {
    expect(filterConnector(undefined)).toBe('and');
    expect(filterConditions(undefined)).toEqual([]);
  });

  it('treats a bare, unwrapped condition as a one-element list without crashing', () => {
    // templates.service.ts (API) seeds a view's filter unwrapped when it has
    // exactly one clause — same shape queryBodyFromConfig sends for a single
    // active condition. filterConditions must not assume every filter has an
    // `and`/`or` key, or a templated workspace's first view load throws.
    const bare = cond({ field: 'assignee', op: 'has', value: ['me'] });
    expect(filterConnector(bare as never)).toBe('and');
    expect(filterConditions(bare as never)).toEqual([bare]);
  });
});

describe('buildFilterGroup — the And/Or toggle', () => {
  const conditions = [cond({ field: 'state' }), cond({ field: 'priority', value: 'high' })];

  it('switching the connector rebuilds the SAME shape the backend already supports (no second format)', () => {
    const andGroup = buildFilterGroup('and', conditions);
    expect(andGroup).toEqual({ and: conditions });

    const orGroup = buildFilterGroup('or', conditions);
    expect(orGroup).toEqual({ or: conditions });

    // Round-trips: connector + conditions survive going back through the readers.
    expect(filterConnector(orGroup)).toBe('or');
    expect(filterConditions(orGroup)).toEqual(conditions);
  });

  it('returns undefined for an empty condition list, in either connector', () => {
    expect(buildFilterGroup('and', [])).toBeUndefined();
    expect(buildFilterGroup('or', [])).toBeUndefined();
  });
});

describe('activeFilterNode — disabled clauses never reach the query', () => {
  it('drops a disabled clause entirely, keeping the rest', () => {
    const group = buildFilterGroup('and', [
      cond({ field: 'state', disabled: true }),
      cond({ field: 'priority', value: 'high' }),
    ]);
    expect(activeFilterNode(group)).toEqual({ field: 'priority', op: 'eq', value: 'high' });
  });

  it('returns undefined when every clause is disabled', () => {
    const group = buildFilterGroup('and', [cond({ disabled: true })]);
    expect(activeFilterNode(group)).toBeUndefined();
  });

  it('strips UI-only fields (pinned/label/icon/disabled) from the survivors', () => {
    const group = buildFilterGroup('and', [
      cond({ pinned: true, label: 'My filter', icon: 'set:flag', disabled: false }),
    ]);
    expect(activeFilterNode(group)).toEqual({ field: 'state', op: 'eq', value: 'done' });
  });

  it('wraps 2+ active conditions under the connector, and sends a bare condition for exactly 1', () => {
    const two = buildFilterGroup('or', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(activeFilterNode(two)).toEqual({
      or: [
        { field: 'a', op: 'eq', value: 'done' },
        { field: 'b', op: 'eq', value: 'done' },
      ],
    });

    const one = buildFilterGroup('or', [cond({ field: 'a' })]);
    expect(activeFilterNode(one)).toEqual({ field: 'a', op: 'eq', value: 'done' });
  });

  it('returns undefined when there is no filter at all', () => {
    expect(activeFilterNode(undefined)).toBeUndefined();
  });
});

describe('reorderConditions — drag-reorder state', () => {
  it('moves a condition from one index to another, keeping the rest in place', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })];
    const reordered = reorderConditions(conditions, 0, 2);
    expect(reordered.map((c) => c.field)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when from === to', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' })];
    expect(reorderConditions(conditions, 1, 1).map((c) => c.field)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' })];
    reorderConditions(conditions, 0, 1);
    expect(conditions.map((c) => c.field)).toEqual(['a', 'b']);
  });
});

describe('pin / label / icon round-trip (the formalized ad-hoc chip pattern)', () => {
  it('a pinned condition keeps its custom label and icon through the group shape', () => {
    const pinned = cond({ pinned: true, label: 'State is none of Done', icon: 'set:flag', op: 'has_none' });
    const group = buildFilterGroup('and', [pinned]);
    const [restored] = filterConditions(group);
    expect(restored).toEqual(pinned);
    expect(restored?.pinned).toBe(true);
    expect(restored?.label).toBe('State is none of Done');
    expect(restored?.icon).toBe('set:flag');
  });

  it('unpinning clears only the pinned flag, leaving label/icon/disabled untouched', () => {
    const pinned = cond({ pinned: true, label: 'Custom name', icon: 'set:flag', disabled: true });
    const conditions = filterConditions(buildFilterGroup('and', [pinned]));
    const unpinned = conditions.map((c) => ({ ...c, pinned: false }));
    expect(unpinned[0]).toEqual({ ...pinned, pinned: false });
  });
});
