import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG, queryBodyFromConfig, sortsBodyFromConfig } from './use-view-state';
import type { FilterNode, ViewConfig } from './use-view-state';

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

/**
 * #259: a personal filter override ANDs on top of the shared view's active
 * filter — mirroring #258/calendar-view.tsx's exact top-level-AND-wrap nesting
 * pattern, never a second composition rule. Narrows only; never replaces or
 * widens the shared view's own filter.
 */
describe('queryBodyFromConfig — personal filter override (#259) ANDs on top of the shared filter', () => {
  const personal: FilterNode = { field: 'assignee', op: 'has', value: ['me'] };

  it('sends just the personal filter when the shared view has none', () => {
    const body = queryBodyFromConfig(EMPTY_CONFIG, personal);
    expect(body.filter).toEqual(personal);
  });

  it('sends just the shared filter when there is no personal override', () => {
    const config = withFilters({ and: [{ field: 'state', op: 'eq', value: 'done' }] });
    const body = queryBodyFromConfig(config, undefined);
    expect(body.filter).toEqual({ field: 'state', op: 'eq', value: 'done' });
  });

  it('wraps both under one {and:[...]} — shared first, personal second — when both are present', () => {
    const config = withFilters({ and: [{ field: 'state', op: 'eq', value: 'done' }] });
    const body = queryBodyFromConfig(config, personal);
    expect(body.filter).toEqual({
      and: [{ field: 'state', op: 'eq', value: 'done' }, personal],
    });
  });

  it('still ANDs the personal filter in even when the shared filter is a multi-condition group', () => {
    const config = withFilters({
      and: [
        { field: 'state', op: 'eq', value: 'done' },
        { field: 'priority', op: 'eq', value: 'high' },
      ],
    });
    const body = queryBodyFromConfig(config, personal);
    expect(body.filter).toEqual({
      and: [
        { and: [{ field: 'state', op: 'eq', value: 'done' }, { field: 'priority', op: 'eq', value: 'high' }] },
        personal,
      ],
    });
  });

  it('omits filter entirely when neither shared nor personal has anything active', () => {
    const config = withFilters({ and: [{ field: 'state', op: 'eq', value: 'done', disabled: true }] });
    expect(queryBodyFromConfig(config, undefined).filter).toBeUndefined();
  });
});

/**
 * MN-252: the empty-values placement wire format. `sorts_nulls` only ever
 * appears on the wire as `nulls: 'first'` — the API's default (omitted) is
 * 'last', so a config that hasn't touched the toggle (or explicitly picked
 * "Bottom") must not send anything, to keep old saved views byte-identical
 * on the wire and never regress the pre-MN-252 NULLS LAST behavior.
 */
describe('queryBodyFromConfig / sortsBodyFromConfig — empty-values placement (nulls)', () => {
  function withSorts(sorts: ViewConfig['sorts'], sorts_nulls?: ViewConfig['sorts_nulls']): ViewConfig {
    return { ...EMPTY_CONFIG, sorts, sorts_nulls };
  }

  it('sends nulls: "first" alongside sorts when placement is Top', () => {
    const config = withSorts([{ field: 'due', direction: 'asc' }], 'first');
    expect(queryBodyFromConfig(config).nulls).toBe('first');
    expect(sortsBodyFromConfig(config)).toEqual({ sorts: [{ field: 'due', direction: 'asc' }], nulls: 'first' });
  });

  it('omits nulls entirely when placement is Bottom (the default) — no wire divergence for old views', () => {
    const config = withSorts([{ field: 'due', direction: 'asc' }], 'last');
    expect(queryBodyFromConfig(config).nulls).toBeUndefined();
    expect(sortsBodyFromConfig(config)).toEqual({ sorts: [{ field: 'due', direction: 'asc' }] });
  });

  it('omits nulls when the field was never set (a pre-MN-252 saved view)', () => {
    const config = withSorts([{ field: 'due', direction: 'asc' }]);
    expect(queryBodyFromConfig(config).nulls).toBeUndefined();
  });

  it('sortsBodyFromConfig is empty when there are no sorts, regardless of the nulls setting', () => {
    expect(sortsBodyFromConfig(withSorts([], 'first'))).toEqual({});
  });

  it('multi-key sorts round-trip through the body in precedence order', () => {
    const config = withSorts([
      { field: 'due', direction: 'asc' },
      { field: 'priority', direction: 'desc' },
    ]);
    expect(queryBodyFromConfig(config).sorts).toEqual([
      { field: 'due', direction: 'asc' },
      { field: 'priority', direction: 'desc' },
    ]);
  });
});
