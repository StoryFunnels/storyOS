import { describe, expect, it } from 'vitest';
import type { ViewConfig } from '@storyos/schemas';
import { cleanViewConfig } from './views.service';

/**
 * MN-258: cleanViewConfig's `cleanFilters` walk was already recursive (it has to
 * be — the schema's FilterNode AST allows and/or nesting ≤3 deep, and a saved
 * view's filter has always gone through this same function regardless of shape)
 * but had ZERO test coverage before this ticket, despite already shipping and
 * being relied on by calendar-view.tsx's nested date-window filter in production.
 * These are pure unit tests — no DB/app needed, `cleanViewConfig` is a plain
 * exported function.
 */

const BASE: Omit<ViewConfig, 'filters'> = {
  sorts: [],
  hidden_field_ids: [],
  card_field_ids: [],
  dashboard_tiles: [],
  dashboard_widgets: [],
  column_widths: {},
};

function clean(filters: ViewConfig['filters'], liveApiNames: string[]) {
  return cleanViewConfig({ ...BASE, filters }, new Set(), new Set(liveApiNames)).filters;
}

describe('cleanViewConfig — recursive field-name pruning through nested and/or groups', () => {
  it('leaves a fully-live nested filter untouched, structurally', () => {
    const filters: ViewConfig['filters'] = {
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ field: 'state', op: 'has', value: ['x'] }, { field: 'priority', op: 'has', value: ['y'] }] },
      ],
    };
    expect(clean(filters, ['estimate', 'state', 'priority'])).toEqual(filters);
  });

  it('drops a dead-field condition from INSIDE a nested group, keeping its live siblings', () => {
    const filters: ViewConfig['filters'] = {
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ field: 'state', op: 'has', value: ['x'] }, { field: 'ghost', op: 'has', value: ['y'] }] },
      ],
    };
    expect(clean(filters, ['estimate', 'state'])).toEqual({
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ field: 'state', op: 'has', value: ['x'] }] },
      ],
    });
  });

  it('collapses (removes) a group entirely once every condition inside it is dead, and cascades if THAT empties its own parent', () => {
    const filters: ViewConfig['filters'] = {
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ field: 'ghost', op: 'has', value: ['y'] }] },
      ],
    };
    expect(clean(filters, ['estimate'])).toEqual({ and: [{ field: 'estimate', op: 'gt', value: 0 }] });

    // Every field dead, at every depth — the whole filter disappears (undefined),
    // not an empty {and:[]} (which the schema itself would reject as < 1 child).
    const allDead: ViewConfig['filters'] = { and: [{ or: [{ field: 'ghost', op: 'eq', value: 1 }] }] };
    expect(clean(allDead, ['estimate'])).toBeUndefined();
  });

  it('recurses through 3 levels of nesting (the schema’s own depth cap) without losing a live leaf', () => {
    const filters: ViewConfig['filters'] = {
      and: [{ or: [{ and: [{ field: 'estimate', op: 'gt', value: 0 }, { field: 'ghost', op: 'eq', value: 1 }] }] }],
    };
    expect(clean(filters, ['estimate'])).toEqual({
      and: [{ or: [{ and: [{ field: 'estimate', op: 'gt', value: 0 }] }] }],
    });
  });

  it('MUTATION CHECK — a non-recursive cleanFilters (only checking top-level "field") would let a dead nested field survive: confirm this suite would catch that', () => {
    // A naive implementation that only inspects the top node's `.field` (missing
    // the and/or branch entirely) would return the filter completely unchanged
    // whenever the top node is a group — including a dead field several levels
    // deep. This test's own assertion above ("drops a dead-field condition from
    // INSIDE a nested group") already fails against that naive shape, since it
    // asserts the pruned tree, not just "no crash" — recorded here as the
    // written proof the coverage is load-bearing, not just present.
    const filters: ViewConfig['filters'] = { and: [{ or: [{ field: 'ghost', op: 'eq', value: 1 }] }] };
    const result = clean(filters, []);
    expect(result).not.toEqual(filters); // a no-op implementation would fail this
    expect(result).toBeUndefined();
  });

  it('is defensive against a bare, unwrapped single condition (no and/or key) — same shape templates.service.ts seeds', () => {
    const bare = { field: 'estimate', op: 'gt', value: 0 } as unknown as ViewConfig['filters'];
    expect(clean(bare, ['estimate'])).toEqual(bare);
    expect(clean(bare, [])).toBeUndefined();
  });
});

describe('cleanViewConfig — dashboard metric tiles (MN-225 / #168)', () => {
  const tiles = (dashboard_tiles: ViewConfig['dashboard_tiles']) =>
    cleanViewConfig({ ...BASE, dashboard_tiles }, new Set(), new Set(['amount'])).dashboard_tiles;

  it('keeps count tiles even with no/dead target field', () => {
    const result = tiles([{ id: '11111111-1111-1111-1111-111111111111', label: 'Total', op: 'count' }]);
    expect(result).toHaveLength(1);
  });

  it('keeps a numeric tile whose target field is still live', () => {
    const result = tiles([
      { id: '22222222-2222-2222-2222-222222222222', label: '', op: 'sum', field_api_name: 'amount' },
    ]);
    expect(result).toHaveLength(1);
  });

  it('drops a numeric tile whose target field was deleted', () => {
    const result = tiles([
      { id: '33333333-3333-3333-3333-333333333333', label: '', op: 'avg', field_api_name: 'ghost' },
    ]);
    expect(result).toHaveLength(0);
  });

  it('defaults to an empty array when tiles are absent', () => {
    expect(tiles(undefined as unknown as ViewConfig['dashboard_tiles'])).toEqual([]);
  });
});

describe('cleanViewConfig — dashboard chart widgets (MN-225 / #168, Phase 2)', () => {
  const widgets = (dashboard_widgets: ViewConfig['dashboard_widgets']) =>
    cleanViewConfig({ ...BASE, dashboard_widgets }, new Set(), new Set(['stage', 'amount']))
      .dashboard_widgets;

  const w = (over: Partial<NonNullable<ViewConfig['dashboard_widgets']>[number]>) => ({
    id: '44444444-4444-4444-4444-444444444444',
    type: 'bar' as const,
    title: '',
    group_by_field_api_name: 'stage',
    measure: { op: 'count' as const },
    ...over,
  });

  it('keeps a count widget whose group-by field is live', () => {
    expect(widgets([w({})])).toHaveLength(1);
  });

  it('keeps a numeric widget when both group-by and measure fields are live', () => {
    expect(widgets([w({ measure: { op: 'sum', field_api_name: 'amount' } })])).toHaveLength(1);
  });

  it('drops a widget whose group-by field was deleted', () => {
    expect(widgets([w({ group_by_field_api_name: 'ghost' })])).toHaveLength(0);
  });

  it('drops a numeric widget whose measure field was deleted', () => {
    expect(widgets([w({ measure: { op: 'avg', field_api_name: 'ghost' } })])).toHaveLength(0);
  });

  it('defaults to an empty array when widgets are absent', () => {
    expect(widgets(undefined as unknown as ViewConfig['dashboard_widgets'])).toEqual([]);
  });
});
