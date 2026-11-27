/**
 * Ticket #1346 — what a SPACE drag in the sidebar should show, as pure functions of the same ids the drop itself resolves against.
 *
 * The drop is `computeReorder(spaces, activeId, overId)`: the dragged space takes the TARGET's slot. Dragging down therefore lands
 * after the target and dragging up lands before it, so the drop line has to sit on the matching edge — a line fixed to the top
 * of the target points at the wrong gap for every downward drag.
 */
export function dropEdge(order: readonly string[], activeId: string, targetId: string): 'top' | 'bottom' {
  const from = order.indexOf(activeId);
  const to = order.indexOf(targetId);
  return from !== -1 && to !== -1 && from < to ? 'bottom' : 'top';
}

/**
 * The group a drop at `overId` would land the space in, or null. `group:<id>` is the group's own header; a member space is
 * "next to a grouped space", which `onSpaceDragEnd` already treats as joining that group; the ungrouped zone and a plain
 * ungrouped space are null. Used to light the group band and indent the line, so what is shown is what will happen.
 */
export function dropGroupId(overId: string | null, spaces: readonly { id: string; groupId?: string | null }[]): string | null {
  if (!overId) return null;
  if (overId.startsWith('group:')) return overId.slice('group:'.length);
  return spaces.find((s) => s.id === overId)?.groupId ?? null;
}

/**
 * Ticket #1346 — keeps the lifted preview (and the collision rect) under the pointer once every space has folded.
 *
 * The pointer's travel is counted from where the drag began, but the fold that starts at the same moment moves the dragged
 * header: dnd-kit only measures it AFTER that render, so a space sitting below three open ones is measured hundreds of pixels
 * higher than the pointer grabbed it, and the preview drew that far from the pointer. `startTop` is the header's top read in
 * `onDragStart`, before the fold rendered; the correction is the difference, and nothing when the header did not move.
 */
export function holdUnderPointer(
  { activeNodeRect, transform }: { activeNodeRect: { top: number } | null; transform: { x: number; y: number; scaleX: number; scaleY: number } },
  startTop: number | null,
) {
  if (startTop === null || !activeNodeRect) return transform;
  return { ...transform, y: transform.y + (startTop - activeNodeRect.top) };
}
