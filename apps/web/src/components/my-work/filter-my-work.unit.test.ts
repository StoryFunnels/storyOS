import { describe, expect, it } from 'vitest';
import { matchesFilters } from './filter-my-work';
import type { MyWorkFilterConfig } from './filter-my-work';

/**
 * MN-297: My Work's client-side filter evaluator (matchOne/matchesFilters) had
 * NO test coverage before this — the `has`/`has_none` ops select/multi_select/
 * relation "is any of"/"is none of" conditions compile to (view-toolbar.tsx's
 * FILTER_OPS) fell through matchOne's `default: return true`, silently
 * no-op-ing every such filter on /w/[ws]/me. matchesFilters lives in
 * filter-my-work.ts (not group-config.tsx) precisely so this test can import
 * it without pulling JSX into the module graph — see that file's header
 * comment and apps/web/vitest.config.ts.
 */

const rec = (values: Record<string, unknown>) => values;

describe('matchesFilters', () => {
  it('is a no-op when there is no filter configured', () => {
    expect(matchesFilters(rec({ state: 'done' }), {})).toBe(true);
  });

  describe('has_none on a single-select field (the exact reported bug)', () => {
    const config: MyWorkFilterConfig = {
      filters: { and: [{ field: 'state', op: 'has_none', value: ['done'] }] },
    };

    it('excludes a record whose select value is the excluded option (State=Done)', () => {
      expect(matchesFilters(rec({ state: 'done' }), config)).toBe(false);
    });

    it('includes a record whose select value is a different option (State=Backlog)', () => {
      expect(matchesFilters(rec({ state: 'backlog' }), config)).toBe(true);
    });
  });

  describe('has on a single-select field ("is any of")', () => {
    const config: MyWorkFilterConfig = {
      filters: { and: [{ field: 'state', op: 'has', value: ['doing', 'done'] }] },
    };

    it('includes a record matching one of the target options', () => {
      expect(matchesFilters(rec({ state: 'doing' }), config)).toBe(true);
    });

    it('excludes a record matching none of the target options', () => {
      expect(matchesFilters(rec({ state: 'backlog' }), config)).toBe(false);
    });
  });

  describe('has/has_none on a multi_select field (array of option ids)', () => {
    const hasConfig: MyWorkFilterConfig = {
      filters: { and: [{ field: 'labels', op: 'has', value: ['bug', 'urgent'] }] },
    };
    const hasNoneConfig: MyWorkFilterConfig = {
      filters: { and: [{ field: 'labels', op: 'has_none', value: ['bug', 'urgent'] }] },
    };

    it('has: includes a record whose array intersects the target set', () => {
      expect(matchesFilters(rec({ labels: ['bug', 'docs'] }), hasConfig)).toBe(true);
    });

    it('has: excludes a record whose array does not intersect', () => {
      expect(matchesFilters(rec({ labels: ['docs'] }), hasConfig)).toBe(false);
    });

    it('has: excludes a record with an empty array', () => {
      expect(matchesFilters(rec({ labels: [] }), hasConfig)).toBe(false);
    });

    it('has_none: excludes a record whose array intersects the target set', () => {
      expect(matchesFilters(rec({ labels: ['bug', 'docs'] }), hasNoneConfig)).toBe(false);
    });

    it('has_none: includes a record whose array does not intersect', () => {
      expect(matchesFilters(rec({ labels: ['docs'] }), hasNoneConfig)).toBe(true);
    });
  });

  describe('has/has_none on a relation field (array of {id, title} chips)', () => {
    const hasConfig: MyWorkFilterConfig = {
      filters: { and: [{ field: 'blocked_by', op: 'has', value: ['rec-1', 'rec-2'] }] },
    };
    const hasNoneConfig: MyWorkFilterConfig = {
      filters: { and: [{ field: 'blocked_by', op: 'has_none', value: ['rec-1', 'rec-2'] }] },
    };

    it('has: includes a record whose linked chip id is in the target set', () => {
      expect(
        matchesFilters(rec({ blocked_by: [{ id: 'rec-1', title: 'Blocker A' }] }), hasConfig),
      ).toBe(true);
    });

    it('has: excludes a record whose linked chip id is not in the target set (compares by id, not reference)', () => {
      expect(
        matchesFilters(rec({ blocked_by: [{ id: 'rec-3', title: 'Blocker C' }] }), hasConfig),
      ).toBe(false);
    });

    it('has: excludes a record with no links at all', () => {
      expect(matchesFilters(rec({ blocked_by: [] }), hasConfig)).toBe(false);
      expect(matchesFilters(rec({}), hasConfig)).toBe(false);
    });

    it('has_none: excludes a record whose linked chip id is in the target set', () => {
      expect(
        matchesFilters(rec({ blocked_by: [{ id: 'rec-2', title: 'Blocker B' }] }), hasNoneConfig),
      ).toBe(false);
    });

    it('has_none: includes a record with no matching links', () => {
      expect(
        matchesFilters(rec({ blocked_by: [{ id: 'rec-9', title: 'Unrelated' }] }), hasNoneConfig),
      ).toBe(true);
      expect(matchesFilters(rec({}), hasNoneConfig)).toBe(true);
    });
  });

  it('combines has_none across a nested And/Or group (MN-258 nesting)', () => {
    const config: MyWorkFilterConfig = {
      filters: {
        and: [
          { field: 'state', op: 'has_none', value: ['done'] },
          { or: [{ field: 'priority', op: 'has', value: ['high'] }, { field: 'estimate', op: 'gt', value: 5 }] },
        ],
      },
    };
    expect(matchesFilters(rec({ state: 'doing', priority: 'high', estimate: 1 }), config)).toBe(true);
    expect(matchesFilters(rec({ state: 'done', priority: 'high', estimate: 1 }), config)).toBe(false);
    expect(matchesFilters(rec({ state: 'doing', priority: 'low', estimate: 1 }), config)).toBe(false);
  });

  it('a disabled condition contributes no opinion (MN-253 non-destructive toggle)', () => {
    const config: MyWorkFilterConfig = {
      filters: { and: [{ field: 'state', op: 'has_none', value: ['done'], disabled: true }] },
    };
    expect(matchesFilters(rec({ state: 'done' }), config)).toBe(true);
  });
});
