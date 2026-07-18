import { arrayMove } from '@dnd-kit/sortable';

/**
 * The sort-builder's pure logic (MN-252) — mirrors filter-config.ts's shape
 * (MN-253). ViewConfig.sorts is already an ordered array, so "drag to reorder
 * precedence" is just an array move (same trick as reorderConditions); this
 * file also owns the whole-sort empty-values placement enum and the
 * field-type-aware direction labels.
 */

export interface SortSpec {
  field: string; // api_name
  direction: 'asc' | 'desc';
}

/**
 * Whole-sort control, not per-key (MN-252 AC): where empty/null values land.
 * Mirrors the query layer's NULLS FIRST/LAST (packages/schemas query.ts,
 * records.service.ts) — 'last' (or undefined) is the pre-MN-252 default.
 */
export type NullsPlacement = 'first' | 'last';

/** Matches the API's `sortSchema` array cap (packages/schemas query.ts) and the
 * cap the column-header "Sort by this field" menu (MN-225/#226) already enforces. */
export const MAX_SORTS = 3;

/** Drag-to-reorder precedence: pure array move, same pattern as reorderConditions. */
export function reorderSorts(sorts: SortSpec[], from: number, to: number): SortSpec[] {
  return arrayMove(sorts, from, to);
}

/** "+ Add" seeds a sensible default (MN-252 AC): the first sortable field not
 * already used by another key, so appending never creates a redundant duplicate. */
export function nextSortField<F extends { apiName: string }>(
  sorts: SortSpec[],
  sortableFields: F[],
): F | undefined {
  const used = new Set(sorts.map((s) => s.field));
  return sortableFields.find((f) => !used.has(f.apiName));
}

/** Field-type-aware direction labels (nice-to-have, MN-252 AC) — falls back to
 * plain Ascending/Descending for types without a more specific idiom. */
const DIRECTION_LABELS: Record<string, { asc: string; desc: string }> = {
  title: { asc: 'A → Z', desc: 'Z → A' },
  text: { asc: 'A → Z', desc: 'Z → A' },
  url: { asc: 'A → Z', desc: 'Z → A' },
  email: { asc: 'A → Z', desc: 'Z → A' },
  select: { asc: 'A → Z', desc: 'Z → A' },
  number: { asc: '1 → 9', desc: '9 → 1' },
  date: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  created_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  updated_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  checkbox: { asc: 'Unchecked → checked', desc: 'Checked → unchecked' },
};

export function directionLabel(fieldType: string, direction: 'asc' | 'desc'): string {
  const labels = DIRECTION_LABELS[fieldType];
  if (labels) return labels[direction];
  return direction === 'asc' ? 'Ascending' : 'Descending';
}
