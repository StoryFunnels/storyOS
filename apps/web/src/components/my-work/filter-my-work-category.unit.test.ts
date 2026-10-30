import { describe, expect, it } from 'vitest';
import { matchesFilters } from './filter-my-work';
import type { MyWorkFilterConfig } from './filter-my-work';

/** #1159 — `category_is` / `category_is_not` evaluated client-side from the field's own option categories (My Work has no query round trip). */
const rec = (values: Record<string, unknown>) => values;

describe('matchesFilters: state category ops', () => {
  const fields = [
    {
      api_name: 'state',
      options: [
        { id: 'todo', category: 'unstarted' as const },
        { id: 'doing', category: 'started' as const },
        { id: 'shipped', category: 'completed' as const },
        { id: 'wontdo', category: 'canceled' as const },
      ],
    },
  ];
  const finished: MyWorkFilterConfig = {
    filters: { and: [{ field: 'state', op: 'category_is', value: ['completed', 'canceled'] }] },
  };
  const open: MyWorkFilterConfig = {
    filters: { and: [{ field: 'state', op: 'category_is_not', value: ['completed', 'canceled'] }] },
  };

  it('keeps only the finished states, whatever they are called', () => {
    expect(matchesFilters(rec({ state: 'shipped' }), finished, fields)).toBe(true);
    expect(matchesFilters(rec({ state: 'wontdo' }), finished, fields)).toBe(true);
    expect(matchesFilters(rec({ state: 'doing' }), finished, fields)).toBe(false);
  });

  it('"not done" keeps the open ones AND a record with no state at all', () => {
    expect(matchesFilters(rec({ state: 'doing' }), open, fields)).toBe(true);
    expect(matchesFilters(rec({ state: 'todo' }), open, fields)).toBe(true);
    expect(matchesFilters(rec({}), open, fields)).toBe(true);
    expect(matchesFilters(rec({ state: 'shipped' }), open, fields)).toBe(false);
  });

  it('without the field list there is no verdict: it excludes nothing rather than guessing either way', () => {
    expect(matchesFilters(rec({ state: 'shipped' }), open)).toBe(true);
    expect(matchesFilters(rec({ state: 'doing' }), finished)).toBe(true);
  });

  it('combines with the ordinary ops in one group', () => {
    const both: MyWorkFilterConfig = {
      filters: {
        and: [
          { field: 'state', op: 'category_is_not', value: ['completed', 'canceled'] },
          { field: 'priority', op: 'eq', value: 'high' },
        ],
      },
    };
    expect(matchesFilters(rec({ state: 'doing', priority: 'high' }), both, fields)).toBe(true);
    expect(matchesFilters(rec({ state: 'shipped', priority: 'high' }), both, fields)).toBe(false);
    expect(matchesFilters(rec({ state: 'doing', priority: 'low' }), both, fields)).toBe(false);
  });
});
