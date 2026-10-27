import { SORTABLE_FIELD_TYPES } from '@storyos/schemas';
import type { Field } from '../table-view/use-table-data';
import { isPickableField } from './system-fields';
import { arrayMove } from '@dnd-kit/sortable';
import { choiceDirectionLabels } from './option-order';
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
 * API's formulaDependsOnlyOnOwnRecord (records.service.ts) exactly.
 *
 * #680 — view-toolbar.tsx's own `SORTABLE` set used to hand-copy the api's
 * SORTABLE_FIELD_TYPES and drifted twice (missing `user` until #662, missing
 * `relation` until this ticket); it now imports that export directly instead
 * of maintaining a second literal, and hideable-columns.unit.test.ts-adjacent
 * coverage (sort-config.unit.test.ts) asserts the two stay equal. `rollup`
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
  number: { asc: '1 → 9', desc: '9 → 1' },
  date: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  created_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  updated_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  checkbox: { asc: 'Unchecked → checked', desc: 'Checked → unchecked' },
  // #352 — system field idioms. `id` (Number/ID) reads as a count; created_by/
  // updated_by sort by the actor's name.
  id: { asc: '1 → 9', desc: '9 → 1' },
  created_by: { asc: 'A → Z', desc: 'Z → A' },
  updated_by: { asc: 'A → Z', desc: 'Z → A' },
  // #662 — sorts by the assigned person's name, same as created_by/updated_by.
  user: { asc: 'A → Z', desc: 'Z → A' },
};

/** Choice fields sort by option POSITION (#961), so their labels come from the real options. */
const CHOICE_TYPES = new Set(['select', 'multi_select', 'workflow']);

/**
 * #963 — "A → Z" was false for choice fields (they sorted by option id, effectively random, until
 * #961) and is still wrong now that they sort by position: the order is the one the field's own
 * options are in. So the label names the first and the last option ("Low → Urgent"), taken from the
 * options passed in (position order, as the API returns them). Without two options there is no order
 * to name, and it says what the order is instead of inventing letters.
 */
export function directionLabel(
  fieldType: string,
  direction: 'asc' | 'desc',
  options?: ReadonlyArray<{ label: string }>,
): string {
  if (CHOICE_TYPES.has(fieldType)) {
    const named = choiceDirectionLabels(options ?? []);
    if (named) return named[direction];
    return direction === 'asc' ? 'Option order' : 'Reverse option order';
  }
  const labels = DIRECTION_LABELS[fieldType];
  if (labels) return labels[direction];
  return direction === 'asc' ? 'Ascending' : 'Descending';
}

const SORTABLE_TYPES = new Set<string>(SORTABLE_FIELD_TYPES);

/**
 * The fields a view can order by: a sortable type, a formula that stays on its
 * own record, never a multi user / relation (no single value to order by, #680)
 * and never a deprecated system field (#743). The one list the Sort panel and
 * the Display menu's Ordering both read, so they cannot drift.
 */
export function sortableFields(fields: Field[]): Field[] {
  const byApiName = new Map(fields.map((f) => [f.apiName, f]));
  return fields.filter(
    (f) =>
      SORTABLE_TYPES.has(f.type) &&
      isSortableFormula(f, byApiName) &&
      !((f.type === 'user' || f.type === 'relation') && f.config['multi'] === true) &&
      // A relation orders rows only when each row holds ONE linked record: the "one" side of a
      // one-to-many (the same rule button-actions-editor.tsx reads). The many side has a set per
      // row, and the API answers a sort by it with an empty page rather than a refusal.
      !(f.type === 'relation' && !(f.relation?.cardinality === 'one_to_many' && f.relation.side === 'a')) &&
      isPickableField(f),
  );
}

/**
 * The order set by ONE choice — a column header, the Display menu's Ordering, the Sort
 * chip's picker. `field` becomes the primary key, ascending; choosing the field that already
 * leads flips it when `flipIfSame` is on (a header click, the picker) and leaves it when off
 * (a menu that has its own flip control). `keepRest` keeps the "then by" keys behind it; a
 * header click drops them. An empty `field` clears the primary key.
 */
export function pickPrimarySort(
  sorts: SortSpec[],
  field: string,
  opts: { keepRest?: boolean; flipIfSame?: boolean } = {},
): SortSpec[] {
  const rest = opts.keepRest ? sorts.slice(1).filter((s) => s.field !== field) : [];
  if (!field) return rest;
  const first = sorts[0];
  const direction: SortSpec['direction'] =
    opts.flipIfSame && first?.field === field ? (first.direction === 'asc' ? 'desc' : 'asc') : 'asc';
  return [{ field, direction }, ...rest];
}
