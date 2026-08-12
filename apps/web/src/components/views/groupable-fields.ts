/**
 * Which fields a view may GROUP BY — the single source of truth for the web.
 *
 * Why this file exists: the rule was written out by hand at every picker, and the
 * copies drifted. #267 fixed "workflow is missing from the pickers" once, and it
 * came back anyway (#272, and the List group-by below) because there were more
 * copies than anyone knew about. The board rule mirrors the server's
 * `boardGroupError` (`apps/api/src/views/views.service.ts`) — that function stays
 * authoritative and rejects a bad config on write; this is the UI's matching read
 * so we never OFFER something the API will refuse.
 *
 * If you add a surface that needs "can this field group?", import from here.
 * Do not re-`filter` on `field.type` at the call site.
 */

/** The shape both predicates need — structurally compatible with the web `Field`. */
export interface GroupableField {
  type: string;
  config?: Record<string, unknown> | null;
  relation?: { cardinality: string; side: string } | null;
}

/**
 * BOARD: one column per value, so the field must be single-valued — otherwise a
 * card would belong in several columns at once and dragging it becomes ambiguous.
 * Mirrors `boardGroupError`: select · workflow · single-user · the single ("a")
 * side of a one-to-many relation.
 */
export function canGroupBoardBy(field: GroupableField): boolean {
  if (field.type === 'select' || field.type === 'workflow') return true;
  if (field.type === 'user') return field.config?.['multi'] !== true;
  if (field.type === 'relation') {
    return field.relation?.cardinality === 'one_to_many' && field.relation?.side === 'a';
  }
  return false;
}

/**
 * LIST: grouped section headers. Narrower than a board on purpose — `list-view.tsx`
 * only resolves a group key for select/workflow today, so offering a relation here
 * would save a config the renderer then ignores. Widen this (and the renderer)
 * together, never one without the other.
 */
export function canGroupListBy(field: GroupableField): boolean {
  return field.type === 'select' || field.type === 'workflow';
}

/**
 * #225 — why a field can't be grouped by, in the user's words. A picker that
 * silently omits a field is indistinguishable from a bug: that misreading is what
 * #267 and #272 were both reported as. Show every field; disable the ones that
 * can't work and say why.
 *
 * Returns null when the field IS groupable for that view type.
 */
export function boardGroupDisabledReason(field: GroupableField): string | null {
  if (canGroupBoardBy(field)) return null;
  if (field.type === 'user') return 'a multi-person field would put one card in several columns';
  if (field.type === 'relation') {
    return field.relation?.cardinality === 'many_to_many'
      ? 'a many-to-many relation would put one card in several columns'
      : 'only the single side of a one-to-many relation can group a board';
  }
  if (field.type === 'multi_select') return 'a multi-select would put one card in several columns';
  if (field.type === 'date') return 'date grouping (by week/month/quarter) is not built yet';
  if (field.type === 'number') return 'number grouping (into bins) is not built yet';
  if (field.type === 'formula' || field.type === 'rollup' || field.type === 'lookup') {
    return 'computed fields cannot group a board yet';
  }
  return `a ${field.type} field cannot group a board`;
}

export function listGroupDisabledReason(field: GroupableField): string | null {
  if (canGroupListBy(field)) return null;
  return canGroupBoardBy(field)
    ? 'a list can only group by a select or status field — try a board'
    : (boardGroupDisabledReason(field) ?? 'this field cannot group a list');
}
