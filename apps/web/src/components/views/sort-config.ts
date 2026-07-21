import { arrayMove } from '@dnd-kit/sortable';
import { formulaRefs } from '@storyos/schemas';
import type { FormulaNode } from '@storyos/schemas';

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

interface SortableFieldLike {
  apiName: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * MN-260/MN-267: a formula field is sortable only if its full dependency chain
 * (through other formulas too) never reaches a `lookup` field — mirrors the
 * API's formulaDependsOnlyOnOwnRecord (records.service.ts) exactly, same as
 * SORTABLE below already mirrors records.service.ts's SORTABLE set. `rollup`
 * is no longer excluded here: MN-267 built real recompute-on-related-record-
 * change plumbing for it (RollupInvalidationSubscriber, materialized into the
 * same computed_values column formula uses), so a formula reaching into a
 * rollup is exactly as safe as one reaching into another formula now. `lookup`
 * still has no such plumbing — a formula reaching into one would silently
 * sort on a value computed as if the related field were always null — the
 * picker excludes it instead of offering a sort that 422s or lies.
 */
export function isSortableFormula(field: SortableFieldLike, byApiName: Map<string, SortableFieldLike>): boolean {
  if (field.type !== 'formula') return true;
  const ast = field.config['ast'] as FormulaNode | undefined;
  if (!ast) return false; // never compiled (e.g. save failed) — not sortable either
  const visited = new Set<string>();
  const walk = (node: FormulaNode): boolean => {
    for (const apiName of formulaRefs(node)) {
      if (visited.has(apiName)) continue;
      visited.add(apiName);
      const target = byApiName.get(apiName);
      if (!target) continue; // dangling ref — not a cross-record concern
      if (target.type === 'lookup') return false;
      if (target.type === 'formula') {
        const targetAst = target.config['ast'] as FormulaNode | undefined;
        if (targetAst && !walk(targetAst)) return false;
      }
    }
    return true;
  };
  return walk(ast);
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
