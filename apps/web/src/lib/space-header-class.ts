import { cn } from '@/lib/utils';
import { vacatedSlotClass } from '@/components/ui/drag-presentation';

/**
 * Ticket #1346 — the class string of a space's header row, given the literal base the sidebar owns (its guards read that literal).
 *
 * Three states change it, all by REPLACING a base class (`cn` merges):
 *  - while any space is dragged the header is not pinned, so `sticky` goes, but it must stay POSITIONED: the drop line is an absolutely
 *    placed child of the row, and a `static` row hands it to the sidebar column, so the line draws at the top or bottom of the whole
 *    list instead of at the target (found in review: y=1499 going down, y=-1 going up). `relative` is the unpinned, positioned state.
 *  - the space that just landed flashes the hover tint in place of the panel colour;
 *  - the space being dragged is the dimmed vacated slot.
 */
export function spaceHeaderClass(base: string, state: { dragging: boolean; flash: boolean; isDragging: boolean }): string {
  return cn(base, state.dragging && 'relative', state.flash && 'bg-hover motion-safe:transition-colors', vacatedSlotClass(state.isDragging));
}
