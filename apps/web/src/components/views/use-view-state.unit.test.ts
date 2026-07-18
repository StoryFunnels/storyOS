import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG, queryBodyFromConfig } from './use-view-state';
import type { ViewConfig } from './use-view-state';

/**
 * MN-253: queryBodyFromConfig is the seam between a saved/draft ViewConfig and the
 * /records/query body every view type (table/board/gallery/list/calendar/timeline)
 * sends. Disabled clauses (the non-destructive "…" menu toggle) must never reach
 * the query, and UI-only fields (pinned/label/icon) must never ride along either.
 */

function withFilters(filters: ViewConfig['filters']): ViewConfig {
  return { ...EMPTY_CONFIG, filters };
}

describe('queryBodyFromConfig — disabled clauses are skipped', () => {
  it('omits filter entirely when the only condition is disabled', () => {
    const config = withFilters({ and: [{ field: 'state', op: 'eq', value: 'done', disabled: true }] });
    const body = queryBodyFromConfig(config);
    expect(body.filter).toBeUndefined();
  });

  it('sends only the enabled clause when one of two is disabled', () => {
    const config = withFilters({
      and: [
        { field: 'state', op: 'eq', value: 'done', disabled: true },
        { field: 'priority', op: 'eq', value: 'high' },
      ],
    });
    const body = queryBodyFromConfig(config);
    expect(body.filter).toEqual({ field: 'priority', op: 'eq', value: 'high' });
  });

  it('strips pinned/label/icon before the wire, even for an enabled clause', () => {
    const config = withFilters({
      and: [{ field: 'state', op: 'eq', value: 'done', pinned: true, label: 'Custom', icon: 'set:flag' }],
    });
    const body = queryBodyFromConfig(config);
    expect(body.filter).toEqual({ field: 'state', op: 'eq', value: 'done' });
  });

  it('respects the Or connector for the surviving enabled clauses', () => {
    const config = withFilters({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2, disabled: true },
        { field: 'c', op: 'eq', value: 3 },
      ],
    });
    const body = queryBodyFromConfig(config);
    expect(body.filter).toEqual({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'c', op: 'eq', value: 3 },
      ],
    });
  });

  it('includes sorts alongside the pruned filter', () => {
    const config: ViewConfig = {
      ...EMPTY_CONFIG,
      filters: { and: [{ field: 'state', op: 'eq', value: 'done' }] },
      sorts: [{ field: 'due', direction: 'asc' }],
    };
    const body = queryBodyFromConfig(config);
    expect(body.sorts).toEqual([{ field: 'due', direction: 'asc' }]);
    expect(body.filter).toEqual({ field: 'state', op: 'eq', value: 'done' });
  });

  it('omits filter when there are no conditions at all', () => {
    expect(queryBodyFromConfig(EMPTY_CONFIG).filter).toBeUndefined();
  });
});
