import { arrayMove } from '@dnd-kit/sortable';

/**
 * The v1 UI filter model (MN-253): a flat list of conditions joined by a single
 * And/Or connector — never mixed within one list. The backend's FilterNode AST
 * already supports {and:[...]} / {or:[...]} (and nesting ≤3 deep, packages/schemas
 * query.ts), so this reuses that shape rather than inventing a second one; the UI
 * just never nests. See docs/architecture (ADR-0003) + the MN-253 spike report.
 */
export interface FilterCondition {
  field: string; // api_name
  op: string;
  value?: unknown;
  /** Non-destructive toggle: stays in the builder, excluded from the query. */
  disabled?: boolean;
  /** Also renders as a standalone chip in the toolbar, outside the builder. */
  pinned?: boolean;
  /** Custom display name — for the condition row and its pinned chip. */
  label?: string;
  /** Icon key (curated set name or emoji) — defaults to the field's type icon. */
  icon?: string;
}

export type FilterConnector = 'and' | 'or';
export type FilterGroup = { and: FilterCondition[] } | { or: FilterCondition[] };

export function filterConnector(filters: FilterGroup | undefined): FilterConnector {
  return filters && 'or' in filters ? 'or' : 'and';
}

/**
 * Reads the condition list out of a persisted filter. Defensive against a bare
 * single condition (no `and`/`or` wrapper): templates.service.ts (API) seeds a
 * view's filter unwrapped when it has exactly one clause, same as
 * queryBodyFromConfig sends for a single active condition — treat it as a
 * one-element list rather than crashing on `.and`/`.or` being undefined.
 */
export function filterConditions(filters: FilterGroup | undefined): FilterCondition[] {
  if (!filters) return [];
  if ('or' in filters) return filters.or;
  if ('and' in filters) return filters.and;
  return [filters as unknown as FilterCondition];
}

export function buildFilterGroup(
  connector: FilterConnector,
  conditions: FilterCondition[],
): FilterGroup | undefined {
  if (conditions.length === 0) return undefined;
  return connector === 'or' ? { or: conditions } : { and: conditions };
}

/** Drag-to-reorder: pure array move, so the row order logic is testable without dnd-kit's DOM events. */
export function reorderConditions(
  conditions: FilterCondition[],
  from: number,
  to: number,
): FilterCondition[] {
  return arrayMove(conditions, from, to);
}

/**
 * What the query actually runs: disabled clauses drop out, UI-only fields
 * (disabled/pinned/label/icon) don't ride along to /records/query. Mirrors
 * packages/schemas' `activeFilter`, kept separately here since the web's
 * FilterCondition is intentionally looser (op: string, mid-edit values) than the
 * API's typed FilterNode.
 */
export function activeFilterNode(filters: FilterGroup | undefined): unknown {
  const connector = filterConnector(filters);
  const active = filterConditions(filters)
    .filter((c) => !c.disabled)
    .map(({ field, op, value }) => ({ field, op, value }));
  if (active.length === 0) return undefined;
  return active.length === 1 ? active[0] : { [connector]: active };
}
