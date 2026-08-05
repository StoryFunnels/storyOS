import { arrayMove } from '@dnd-kit/sortable';

/**
 * Shared drag-to-reorder helper for position-ordered lists (#337, #338).
 *
 * Given the current list (in its persisted order) and the active/over ids from
 * a dnd-kit `DragEndEvent`, returns the minimal set of `{ id, position }` writes
 * needed to persist the new order — only the items whose index actually moved.
 *
 * This is the same arrayMove-then-reindex pattern the view tabs, table columns,
 * and record panels already use; centralising it keeps every reorder surface
 * collision-free (positions become a contiguous 0..n-1 run) instead of the old
 * two-item "swap" that left the items dragged over untouched.
 */
export function computeReorder<T extends { id: string }>(
  items: T[],
  activeId: string,
  overId: string,
): Array<{ id: string; position: number }> {
  if (activeId === overId) return [];
  const from = items.findIndex((i) => i.id === activeId);
  const to = items.findIndex((i) => i.id === overId);
  if (from < 0 || to < 0) return [];
  return arrayMove(items, from, to)
    .map((item, index) => ({ id: item.id, position: index }))
    .filter((move, index) => items[index]?.id !== move.id);
}

/**
 * Drag-to-reorder helper for the canonical database field order (#338).
 *
 * Unlike {@link computeReorder}, this reindexes over the FULL ordered field
 * list but only emits writes for user fields (`isSystem === false`) — system
 * fields (id / title / created_at / …) keep their fixed slots and the API
 * rejects position edits on them. Assigning `position` = index-in-full-list
 * (rather than index-within-the-user-subset) keeps this surface numerically
 * consistent with the table's column reorder, so both are two views of ONE
 * canonical order. `activeId`/`overId` are always user fields (only those carry
 * a drag handle), so the moved run never crosses into the frozen system prefix.
 */
export function fieldReorderMoves<T extends { id: string; isSystem: boolean; type: string }>(
  fields: T[],
  activeId: string,
  overId: string,
): Array<{ fieldId: string; position: number }> {
  if (activeId === overId) return [];
  const from = fields.findIndex((f) => f.id === activeId);
  const to = fields.findIndex((f) => f.id === overId);
  if (from < 0 || to < 0) return [];
  return arrayMove(fields, from, to)
    .map((field, index) => ({ field, index }))
    // #76: the title field is frozen (position 0) but carries isSystem:false, so
    // it slipped this filter and got a needless (API-rejected) position write on
    // every reorder. `type === 'title'` is the frozen marker used everywhere else
    // in the app, so exclude it here too — no isSystem flip (that would ripple
    // into the many surfaces that filter on isSystem).
    .filter(({ field }) => !field.isSystem && field.type !== 'title')
    .map(({ field, index }) => ({ fieldId: field.id, position: index }));
}
