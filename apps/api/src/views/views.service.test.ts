import { describe, expect, it } from 'vitest';
import type { ViewConfig } from '@storyos/schemas';
import { boardGroupError, cleanViewConfig, defaultBoardGroupBy } from './views.service';

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

describe('defaultBoardGroupBy — Board defaults to the workflow field (#181)', () => {
  const WF = { id: 'wf-1', type: 'workflow' };
  const SELECT = { id: 'sel-1', type: 'select' };
  const cfg = (over: Partial<ViewConfig> = {}): ViewConfig => ({ ...BASE, filters: undefined, ...over });

  it('fills an absent group-by on a Board with the workflow field', () => {
    expect(defaultBoardGroupBy('board', cfg(), [SELECT, WF]).group_by_field_id).toBe('wf-1');
  });

  it('never overrides an explicit group-by choice', () => {
    const out = defaultBoardGroupBy('board', cfg({ group_by_field_id: 'sel-1' }), [SELECT, WF]);
    expect(out.group_by_field_id).toBe('sel-1');
  });

  it('leaves the config untouched when the database has no workflow field', () => {
    expect(defaultBoardGroupBy('board', cfg(), [SELECT]).group_by_field_id).toBeUndefined();
  });

  it('does not touch non-board views', () => {
    expect(defaultBoardGroupBy('table', cfg(), [WF]).group_by_field_id).toBeUndefined();
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

  // #305: switching a tile Count→Sum yields {op:'sum'} with no field yet — on a
  // database with no number field there is nothing to default it to. That tile is
  // UNCONFIGURED, not dangling, and stripping it here made the card vanish from
  // the UI on the next read ("as soon as I change count to smth else it deletes
  // the card"). Only a NAMED-but-missing field is junk.
  it('keeps a numeric tile that has no target field yet (mid-configuration, #305)', () => {
    const result = tiles([{ id: '55555555-5555-5555-5555-555555555555', label: '', op: 'sum' }]);
    expect(result).toHaveLength(1);
  });

  // #304: a tile carries its OWN filter so each tile can measure a different slice.
  // It must survive the read path (the zod config would strip an unknown key) and get
  // the same dead-field pruning the view's own filter gets.
  it('keeps a tile filter, and prunes only its dead conditions (#304)', () => {
    const result = tiles([
      {
        id: '66666666-6666-6666-6666-666666666666',
        label: '',
        op: 'count',
        filter: { and: [{ field: 'amount', op: 'gt', value: 5 }] },
      } as never,
    ]);
    expect(result).toHaveLength(1);
    expect(result![0]!.filter).toEqual({ and: [{ field: 'amount', op: 'gt', value: 5 }] });
  });

  it('drops a tile-filter condition on a deleted field but keeps the tile (#304)', () => {
    const result = tiles([
      {
        id: '77777777-7777-7777-7777-777777777777',
        label: '',
        op: 'count',
        filter: { and: [{ field: 'ghost', op: 'eq', value: 1 }] },
      } as never,
    ]);
    // The tile is still configured — only the dead condition goes (#305's rule).
    expect(result).toHaveLength(1);
    expect(result![0]!.filter).toBeUndefined();
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

  // #305: "Add chart" creates a widget with NO group-by — you pick the field
  // afterwards. Requiring one here stripped the widget on the very next read, so a
  // new chart could never survive long enough to be configured.
  it('keeps a freshly added widget that has no group-by field yet (#305)', () => {
    expect(widgets([w({ group_by_field_api_name: undefined })])).toHaveLength(1);
  });

  it('keeps an unconfigured widget whose numeric measure has no field yet (#305)', () => {
    expect(
      widgets([w({ group_by_field_api_name: undefined, measure: { op: 'sum' } })]),
    ).toHaveLength(1);
  });

  it('defaults to an empty array when widgets are absent', () => {
    expect(widgets(undefined as unknown as ViewConfig['dashboard_widgets'])).toEqual([]);
  });
});

describe('cleanViewConfig — empty-values placement (MN-252 / #196)', () => {
  const withSort = (over: Partial<ViewConfig>): ViewConfig =>
    cleanViewConfig(
      { ...BASE, sorts: [{ field: 'amount', direction: 'asc' }], ...over },
      new Set(),
      new Set(['amount']),
    );

  it('preserves sorts_nulls: "first" so the empty-values toggle survives a save', () => {
    expect(withSort({ sorts_nulls: 'first' }).sorts_nulls).toBe('first');
  });

  it('preserves sorts_nulls: "last"', () => {
    expect(withSort({ sorts_nulls: 'last' }).sorts_nulls).toBe('last');
  });

  it('leaves sorts_nulls undefined when unset (back-compat: old saved sorts compile unchanged)', () => {
    expect(withSort({}).sorts_nulls).toBeUndefined();
  });
});

describe('boardGroupError — #307: a date field groups a board into periods', () => {
  it('accepts a date field', () => {
    expect(boardGroupError({ type: 'date', config: {} }, null)).toBeNull();
  });

  it('still accepts select / workflow / single user / 1:M side a', () => {
    expect(boardGroupError({ type: 'select', config: {} }, null)).toBeNull();
    expect(boardGroupError({ type: 'workflow', config: {} }, null)).toBeNull();
    expect(boardGroupError({ type: 'user', config: {} }, null)).toBeNull();
    expect(
      boardGroupError({ type: 'relation', config: { side: 'a' } }, { cardinality: 'one_to_many' }),
    ).toBeNull();
  });

  it('still REJECTS the multi-valued cases — a card cannot live in two columns', () => {
    expect(boardGroupError({ type: 'user', config: { multi: true } }, null)).toContain(
      'several columns',
    );
    expect(
      boardGroupError({ type: 'relation', config: { side: 'b' } }, { cardinality: 'one_to_many' }),
    ).toContain('several columns');
    expect(
      boardGroupError({ type: 'relation', config: { side: 'a' } }, { cardinality: 'many_to_many' }),
    ).toContain('several columns');
    expect(boardGroupError({ type: 'multi_select', config: {} }, null)).toBeTruthy();
  });

  it('carries group_by_granularity through cleanViewConfig', () => {
    const out = cleanViewConfig(
      { ...BASE, filters: undefined, group_by_granularity: 'quarter' } as ViewConfig,
      new Set(),
      new Set(),
    );
    expect(out.group_by_granularity).toBe('quarter');
  });
});

/**
 * #227 + a guard for every key after it. `cleanViewConfig` is an explicit
 * ALLOWLIST: it rebuilds the config key by key, so any key added to
 * `viewConfigSchema` but not copied here is silently discarded on read. That is
 * how #227's baseline pair shipped broken — it saved to the database correctly
 * and vanished on every read, so the picker could never show it back.
 *
 * TypeScript cannot catch this (every added key is optional, so an object
 * literal that omits it still satisfies `ViewConfig`), which is exactly why it
 * needs a test.
 */
describe('#227 — the timeline baseline pair survives a read', () => {
  const FIELD_A = '11111111-1111-4111-8111-111111111111';
  const FIELD_B = '22222222-2222-4222-8222-222222222222';

  const withBaseline = (over: Partial<ViewConfig> = {}): ViewConfig => ({
    ...BASE,
    filters: undefined,
    start_date_field_id: FIELD_A,
    end_date_field_id: FIELD_B,
    baseline_start_date_field_id: FIELD_A,
    baseline_end_date_field_id: FIELD_B,
    ...over,
  });

  it('keeps both baseline ids when the fields they name are live', () => {
    const out = cleanViewConfig(withBaseline(), new Set([FIELD_A, FIELD_B]), new Set());
    expect(out.baseline_start_date_field_id).toBe(FIELD_A);
    expect(out.baseline_end_date_field_id).toBe(FIELD_B);
  });

  it('drops a baseline id whose field was deleted — dangling, like the primary pair', () => {
    const out = cleanViewConfig(withBaseline(), new Set([FIELD_A]), new Set());
    expect(out.baseline_start_date_field_id).toBe(FIELD_A);
    expect(out.baseline_end_date_field_id).toBeUndefined();
  });

  it('leaves a view with no baseline configured alone (absent is not invalid)', () => {
    const out = cleanViewConfig(
      withBaseline({ baseline_start_date_field_id: undefined, baseline_end_date_field_id: undefined }),
      new Set([FIELD_A, FIELD_B]),
      new Set(),
    );
    expect(out.baseline_start_date_field_id).toBeUndefined();
    expect(out.start_date_field_id).toBe(FIELD_A);
  });
});

/**
 * The generic guard. Rather than trusting whoever adds the NEXT config key to
 * remember this function, assert that every scalar id-ish key the schema accepts
 * still comes back out. If this fails, someone widened `viewConfigSchema` and
 * forgot `cleanViewConfig` — the failure message names the key.
 */
describe('cleanViewConfig — no schema key is silently dropped on read', () => {
  it('round-trips every *_field_id key the schema accepts', () => {
    const LIVE = '33333333-3333-4333-8333-333333333333';
    // Every scalar UUID-valued key in viewConfigSchema. Add to this list when the
    // schema grows one; the point is that the list and the function stay in step.
    const idKeys = [
      'group_by_field_id',
      'color_by_field_id',
      'date_field_id',
      'start_date_field_id',
      'end_date_field_id',
      'baseline_start_date_field_id',
      'baseline_end_date_field_id',
    ] as const;

    const config = { ...BASE, filters: undefined } as unknown as Record<string, unknown>;
    for (const k of idKeys) config[k] = LIVE;

    const out = cleanViewConfig(config as unknown as ViewConfig, new Set([LIVE]), new Set()) as unknown as Record<
      string,
      unknown
    >;
    const dropped = idKeys.filter((k) => out[k] !== LIVE);
    expect(dropped, `cleanViewConfig dropped these live keys: ${dropped.join(', ')}`).toEqual([]);
  });
});
