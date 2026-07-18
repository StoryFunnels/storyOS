import { describe, expect, it } from 'vitest';
import { MAX_SORTS, directionLabel, isSortableFormula, nextSortField, reorderSorts } from './sort-config';
import type { SortSpec } from './sort-config';

/**
 * MN-252: the sort-builder's pure logic — drag-reorder precedence, the "+ Add"
 * default-field pick, and the field-type-aware direction labels. Mirrors
 * filter-config.unit.test.ts's approach (MN-253): keep the DOM/dnd-kit-event-free
 * logic testable on its own.
 */

const sort = (over: Partial<SortSpec>): SortSpec => ({ field: 'due', direction: 'asc', ...over });

describe('reorderSorts — drag-reorder precedence', () => {
  it('moves a sort key from one index to another, keeping the rest in place', () => {
    const sorts = [sort({ field: 'a' }), sort({ field: 'b' }), sort({ field: 'c' })];
    const reordered = reorderSorts(sorts, 0, 2);
    expect(reordered.map((s) => s.field)).toEqual(['b', 'c', 'a']);
  });

  it('moving the primary key (index 0) to last makes the second key the new primary', () => {
    const sorts = [sort({ field: 'priority', direction: 'desc' }), sort({ field: 'due', direction: 'asc' })];
    const reordered = reorderSorts(sorts, 0, 1);
    expect(reordered).toEqual([sort({ field: 'due', direction: 'asc' }), sort({ field: 'priority', direction: 'desc' })]);
  });

  it('is a no-op when from === to', () => {
    const sorts = [sort({ field: 'a' }), sort({ field: 'b' })];
    expect(reorderSorts(sorts, 1, 1).map((s) => s.field)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const sorts = [sort({ field: 'a' }), sort({ field: 'b' })];
    reorderSorts(sorts, 0, 1);
    expect(sorts.map((s) => s.field)).toEqual(['a', 'b']);
  });
});

describe('nextSortField — "+ Add" seeds a sensible default', () => {
  const fields = [{ apiName: 'due' }, { apiName: 'priority' }, { apiName: 'estimate' }];

  it('picks the first field not already used by an existing key', () => {
    expect(nextSortField([], fields)?.apiName).toBe('due');
    expect(nextSortField([sort({ field: 'due' })], fields)?.apiName).toBe('priority');
  });

  it('skips every already-used field, in order', () => {
    const used = [sort({ field: 'due' }), sort({ field: 'priority' })];
    expect(nextSortField(used, fields)?.apiName).toBe('estimate');
  });

  it('returns undefined once every sortable field is already a key', () => {
    const used = fields.map((f) => sort({ field: f.apiName }));
    expect(nextSortField(used, fields)).toBeUndefined();
  });
});

describe('directionLabel — field-type-aware idioms (nice-to-have AC)', () => {
  it('uses A→Z / Z→A for text-ish and select fields', () => {
    for (const type of ['title', 'text', 'url', 'email', 'select']) {
      expect(directionLabel(type, 'asc')).toBe('A → Z');
      expect(directionLabel(type, 'desc')).toBe('Z → A');
    }
  });

  it('uses 1→9 / 9→1 for number fields', () => {
    expect(directionLabel('number', 'asc')).toBe('1 → 9');
    expect(directionLabel('number', 'desc')).toBe('9 → 1');
  });

  it('uses oldest/newest for date-ish fields', () => {
    for (const type of ['date', 'created_at', 'updated_at']) {
      expect(directionLabel(type, 'asc')).toBe('Oldest → newest');
      expect(directionLabel(type, 'desc')).toBe('Newest → oldest');
    }
  });

  it('falls back to plain Ascending/Descending for types without a specific idiom', () => {
    expect(directionLabel('relation', 'asc')).toBe('Ascending');
    expect(directionLabel('relation', 'desc')).toBe('Descending');
  });
});

describe('MAX_SORTS', () => {
  it('matches the API sortSchema cap (packages/schemas query.ts) and the header-cell toast', () => {
    expect(MAX_SORTS).toBe(3);
  });
});

/**
 * MN-260: mirrors records.service.ts's formulaDependsOnlyOnOwnRecord — a formula
 * is sortable only if its full dependency chain (through other formulas too)
 * never reaches a lookup or rollup field, since those pull from a related record
 * that isn't materialized for sorting.
 */
describe('isSortableFormula', () => {
  type F = { apiName: string; type: string; config: Record<string, unknown> };
  const field = (over: Partial<F>): F => ({ apiName: 'f', type: 'formula', config: {}, ...over });
  const ref = (apiName: string) => ({ kind: 'ref' as const, api_name: apiName });

  it('is true for non-formula fields (nothing to gate)', () => {
    expect(isSortableFormula(field({ type: 'number' }), new Map())).toBe(true);
  });

  it('is true for a formula referencing only plain same-record fields', () => {
    const estimate = field({ apiName: 'estimate', type: 'number' });
    const remaining = field({
      apiName: 'remaining',
      config: { ast: { kind: 'binary', op: '-', left: ref('estimate'), right: { kind: 'lit', value: 1 } } },
    });
    const byApiName = new Map([['estimate', estimate], ['remaining', remaining]]);
    expect(isSortableFormula(remaining, byApiName)).toBe(true);
  });

  it('is false for a formula that directly references a rollup', () => {
    const daysUsed = field({ apiName: 'days_used', type: 'rollup' });
    const balance = field({ apiName: 'balance', config: { ast: ref('days_used') } });
    const byApiName = new Map([['days_used', daysUsed], ['balance', balance]]);
    expect(isSortableFormula(balance, byApiName)).toBe(false);
  });

  it('is false for a formula that directly references a lookup', () => {
    const parentState = field({ apiName: 'parent_state', type: 'lookup' });
    const health = field({ apiName: 'health', config: { ast: ref('parent_state') } });
    const byApiName = new Map([['parent_state', parentState], ['health', health]]);
    expect(isSortableFormula(health, byApiName)).toBe(false);
  });

  it('is false transitively, through a chain of formula-over-formula', () => {
    const daysUsed = field({ apiName: 'days_used', type: 'rollup' });
    const balance = field({ apiName: 'balance', config: { ast: ref('days_used') } });
    const doubled = field({ apiName: 'doubled', config: { ast: { kind: 'binary', op: '*', left: ref('balance'), right: { kind: 'lit', value: 2 } } } });
    const byApiName = new Map([['days_used', daysUsed], ['balance', balance], ['doubled', doubled]]);
    expect(isSortableFormula(doubled, byApiName)).toBe(false);
  });

  it('is true when a dangling ref resolves to nothing (not a cross-record concern)', () => {
    const orphan = field({ apiName: 'orphan', config: { ast: ref('deleted_field') } });
    expect(isSortableFormula(orphan, new Map([['orphan', orphan]]))).toBe(true);
  });

  it('is false when the field has no compiled ast (never saved successfully)', () => {
    const broken = field({ apiName: 'broken', config: {} });
    expect(isSortableFormula(broken, new Map([['broken', broken]]))).toBe(false);
  });
});
