import { describe, expect, it } from 'vitest';
import { flattenHierarchy, isHierarchyField } from './use-hierarchy';
import type { HierarchyChildData } from './use-hierarchy';
import type { Field, RecordRow } from './use-table-data';

/**
 * #233 — table view's inline hierarchy mode. `isHierarchyField` and
 * `flattenHierarchy` are the two pure pieces this feature's correctness
 * actually rests on (everything else in use-hierarchy.ts is data-fetching
 * plumbing around them), so they get direct unit coverage independent of any
 * DOM/virtualizer/React Query harness — the same posture range-select.ts's
 * own tests already take for the selection math they carry.
 */

const DB = 'db-1';

function relationField(over: Partial<NonNullable<Field['relation']>> = {}): Field {
  return {
    id: 'f-parent',
    apiName: 'parent',
    displayName: 'Parent',
    type: 'relation',
    config: {},
    isSystem: false,
    relation: {
      id: 'rel-1',
      cardinality: 'one_to_many',
      side: 'a',
      target_database_id: DB,
      target_database_name: 'Items',
      inverse_field_id: 'f-subitems',
      ...over,
    },
  };
}

function row(id: string, title = id): RecordRow {
  return {
    id,
    number: null,
    title,
    values: {},
    position: '0',
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('isHierarchyField — #344\'s "single side of a one-to-many relation" test, applied to nesting', () => {
  it('accepts a self-referential one-to-many relation on its "Parent" (side a)', () => {
    expect(isHierarchyField(relationField(), DB)).toBe(true);
  });

  it('rejects the inverse "Sub-items" side (side b) — the many side has no single parent to nest under', () => {
    expect(isHierarchyField(relationField({ side: 'b' }), DB)).toBe(false);
  });

  it('rejects a many-to-many self-relation — no side of it is single-valued', () => {
    expect(isHierarchyField(relationField({ cardinality: 'many_to_many' }), DB)).toBe(false);
  });

  it('rejects a relation pointing at a DIFFERENT database — not self-referential', () => {
    expect(isHierarchyField(relationField({ target_database_id: 'db-2' }), DB)).toBe(false);
  });

  it('rejects a non-relation field outright', () => {
    const field: Field = {
      id: 'f-text',
      apiName: 'notes',
      displayName: 'Notes',
      type: 'text',
      config: {},
      isSystem: false,
    };
    expect(isHierarchyField(field, DB)).toBe(false);
  });
});

describe('flattenHierarchy — interleaves loaded children directly after their parent, depth-first', () => {
  it('returns root rows unchanged, depth 0, when nothing is expanded', () => {
    const roots = [row('a'), row('b')];
    const out = flattenHierarchy(roots, new Map(), new Set());
    expect(out.map((h) => [h.row.id, h.depth, h.isExpanded])).toEqual([
      ['a', 0, false],
      ['b', 0, false],
    ]);
  });

  it('inserts a row\'s loaded children directly beneath it, one level deeper', () => {
    const roots = [row('a'), row('b')];
    const children = new Map<string, HierarchyChildData>([
      ['a', { rows: [row('a1'), row('a2')], hasMore: false, isLoading: false }],
    ]);
    const out = flattenHierarchy(roots, children, new Set(['a']));
    expect(out.map((h) => [h.row.id, h.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a2', 1],
      ['b', 0],
    ]);
  });

  it('recurses through more than two levels when each level is expanded', () => {
    const roots = [row('a')];
    const children = new Map<string, HierarchyChildData>([
      ['a', { rows: [row('a1')], hasMore: false, isLoading: false }],
      ['a1', { rows: [row('a1x')], hasMore: false, isLoading: false }],
    ]);
    const out = flattenHierarchy(roots, children, new Set(['a', 'a1']));
    expect(out.map((h) => [h.row.id, h.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
    ]);
  });

  it('an expanded row with no loaded children yet contributes no rows, but is marked expanded and loading', () => {
    const roots = [row('a')];
    const out = flattenHierarchy(roots, new Map(), new Set(['a']));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ row: { id: 'a' }, isExpanded: true, childrenLoading: true });
  });

  it('a COLLAPSED row never reveals its children, even if some are already cached', () => {
    const roots = [row('a')];
    const children = new Map<string, HierarchyChildData>([
      ['a', { rows: [row('a1')], hasMore: false, isLoading: false }],
    ]);
    const out = flattenHierarchy(roots, children, new Set());
    expect(out.map((h) => h.row.id)).toEqual(['a']);
  });

  it('surfaces hasMoreChildren for an expanded row whose children were truncated at the page ceiling', () => {
    const roots = [row('a')];
    const children = new Map<string, HierarchyChildData>([
      ['a', { rows: [row('a1')], hasMore: true, isLoading: false }],
    ]);
    const out = flattenHierarchy(roots, children, new Set(['a']));
    expect(out.find((h) => h.row.id === 'a')?.hasMoreChildren).toBe(true);
    expect(out.find((h) => h.row.id === 'a1')?.hasMoreChildren).toBe(false);
  });
});
