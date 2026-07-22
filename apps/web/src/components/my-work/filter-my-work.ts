import { isFilterGroup, nodeChildren, nodeConnector } from '@/components/views/filter-config';
import type { FilterGroup, FilterNode } from '@/components/views/filter-config';

/**
 * MN-297: My Work's client-side filter evaluator — a plain `.ts` module (not
 * `.tsx`) on purpose, same reasoning as sort-my-work.ts: apps/web/vitest.config.ts's
 * `*.unit.test.ts` harness is JSX-free, so this pure filter logic lives here
 * rather than inline in group-config.tsx where it would drag the whole
 * component file's JSX into the test's module graph and break `vitest run`.
 *
 * Mirrors the query layer's filter semantics (apps/api/src/records/query-compiler.ts
 * compileIdSet/compileRelation) applied here to the already-fetched My Work rows
 * instead of at the DB layer — My Work has no per-group query round trip.
 */

export interface MyWorkFilterConfig {
  filters?: FilterGroup;
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Normalizes a field's stored value into an array of string ids, covering
 * every shape `has`/`has_none` need to compare against:
 *  - single-select: a scalar option id ('opt_1')
 *  - multi_select: an array of option ids (['opt_1', 'opt_2'])
 *  - relation: an array of chip objects ({id, title}) — compared by `.id`,
 *    matching board-view.tsx's LinkChip handling, not by reference. */
function idsOf(value: unknown): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) =>
    v !== null && typeof v === 'object' && 'id' in (v as Record<string, unknown>)
      ? String((v as { id: unknown }).id)
      : String(v),
  );
}

function matchOne(value: unknown, op: string, target: unknown): boolean {
  const s = (x: unknown) => String(x ?? '').toLowerCase();
  const has = (x: unknown) => Array.isArray(value) && value.map(String).includes(String(x));
  switch (op) {
    case 'is_empty':
      return isEmpty(value);
    case 'is_not_empty':
      return !isEmpty(value);
    case 'eq':
    case 'is':
      return s(value) === s(target) || has(target);
    case 'neq':
    case 'is_not':
      return !(s(value) === s(target) || has(target));
    case 'contains':
      return s(value).includes(s(target)) || has(target);
    case 'not_contains':
      return !(s(value).includes(s(target)) || has(target));
    case 'gt':
      return Number(value) > Number(target);
    case 'gte':
      return Number(value) >= Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'before':
      return String(value) < String(target);
    case 'after':
      return String(value) > String(target);
    case 'on':
      return String(value).slice(0, 10) === String(target).slice(0, 10);
    // MN-297: select/multi_select/relation "is any of" / "is none of" (view-toolbar.tsx's
    // FILTER_OPS) compile to has/has_none, mirroring query-compiler.ts's compileIdSet /
    // compileRelation — has = the field's ids intersect the filter's value array,
    // has_none = no intersection. Previously fell through to `default: return true`,
    // silently no-op-ing every select/multi_select/relation filter on this page.
    case 'has': {
      const targets = (Array.isArray(target) ? target : [target]).map(String);
      const ids = idsOf(value);
      return ids.some((id) => targets.includes(id));
    }
    case 'has_none': {
      const targets = (Array.isArray(target) ? target : [target]).map(String);
      const ids = idsOf(value);
      return !ids.some((id) => targets.includes(id));
    }
    default:
      return true; // unknown op → don't filter anything out
  }
}

/** Recursively evaluates one node of the filter tree against a record's values.
 * Mirrors the API's compileFilter/activeFilter recursion (MN-258): a group's
 * result is its children's results combined by its OWN connector; a disabled
 * leaf (MN-253 UI) contributes no opinion (`undefined`), same as it dropping out
 * of activeFilterNode for saved views. `undefined` propagates up through an empty
 * group exactly like an empty filter — "no verdict" reads as "don't exclude". */
function evaluateNode(node: FilterNode, values: Record<string, unknown>): boolean | undefined {
  if (isFilterGroup(node)) {
    const results = nodeChildren(node)
      .map((child) => evaluateNode(child, values))
      .filter((r): r is boolean => r !== undefined);
    if (results.length === 0) return undefined;
    return nodeConnector(node) === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
  if (node.disabled) return undefined;
  return matchOne(values[node.field], node.op, node.value);
}

/** Client-side And/Or filter over the returned records (My Work is a bounded set),
 * supporting nested groups (MN-258) — My Work shares the SAME `FiltersSection`
 * builder + persisted `FilterGroup` shape as saved views, so a group built here
 * must be evaluated with the same and/or nesting the server would apply. */
export function matchesFilters(values: Record<string, unknown>, config: MyWorkFilterConfig): boolean {
  if (!config.filters) return true;
  return evaluateNode(config.filters, values) ?? true;
}
