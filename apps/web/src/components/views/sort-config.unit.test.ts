import { describe, expect, it } from 'vitest';
import { MAX_SORTS, directionLabel, nextSortField, reorderSorts } from './sort-config';
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
