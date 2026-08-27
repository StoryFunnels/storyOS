'use client';

import { useMemo, useState } from 'react';
import { DragOverlay } from '@dnd-kit/core';
import type { Announcements, DragStartEvent, DragEndEvent, DragCancelEvent, DragMoveEvent } from '@dnd-kit/core';
import { blockAnnouncements } from './drag-announcements';
import type { DragLabeller } from './drag-announcements';
import { cn } from '@/lib/utils';

/**
 * How a drag LOOKS and SOUNDS, in one place (#409, #412, #415).
 *
 * Three tickets, one cause. Every sortable list in the app except the board left
 * the dragged node in the flow with a pointer-following transform, so it painted
 * on top of its stationary neighbours — a table header literally read "Stagunt"
 * mid-drag. There was no insertion marker anywhere, so the only clue about where
 * a drop would land was the neighbours shuffling, which (because of the overlap)
 * read as a rendering glitch. And every announcement was dnd-kit's stock string
 * with a uuid substituted in: "Picked up draggable item 102568ca-…".
 *
 * `board-view.tsx` already used a `<DragOverlay>` and looks correct today — this
 * generalises what it does rather than inventing a second approach. That is the
 * whole point: #380 and #383 both document the same failure, where behaviour
 * living per component means the component written NEXT does not inherit it.
 */

export type { DragLabeller };

export interface DragPresentation {
  /** The id currently being dragged, or null. */
  activeId: string | null;
  /** The id the pointer is currently over, or null. */
  overId: string | null;
  /** Spread onto `<DndContext>`: tracks the drag and supplies announcements. */
  contextProps: {
    onDragStart: (e: DragStartEvent) => void;
    onDragOver: (e: DragMoveEvent) => void;
    onDragEnd: (e: DragEndEvent) => void;
    onDragCancel: (e: DragCancelEvent) => void;
    accessibility: { announcements: Announcements };
  };
}

/**
 * Track a drag and describe it out loud.
 *
 * `onDragEnd`/`onDragCancel` are wrapped rather than replaced — the caller's own
 * handler still runs, then the active id is cleared. Forgetting to clear it
 * leaves a ghost overlay pinned to the screen, which is worse than the bug this
 * fixes.
 */
export function useDragPresentation(
  label: DragLabeller,
  handlers: {
    onDragEnd?: (e: DragEndEvent) => void;
    onDragStart?: (e: DragStartEvent) => void;
  } = {},
  /** For "3 of 8" in announcements. Omit when the list length is not known. */
  items?: readonly string[],
): DragPresentation {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // #415 — the strings live in `drag-announcements.ts` so they can be asserted
  // without a DOM; see the uuid regression guard in its unit test.
  const announcements = useMemo(() => blockAnnouncements(label, items), [label, items]);

  return {
    activeId,
    overId,
    contextProps: {
      onDragStart: (e) => {
        setActiveId(String(e.active.id));
        handlers.onDragStart?.(e);
      },
      onDragOver: (e) => setOverId(e.over ? String(e.over.id) : null),
      onDragEnd: (e) => {
        handlers.onDragEnd?.(e);
        setActiveId(null);
        setOverId(null);
      },
      onDragCancel: () => {
        setActiveId(null);
        setOverId(null);
      },
      accessibility: { announcements },
    },
  };
}

/**
 * The floating preview (#409).
 *
 * `<DragOverlay>` renders OUTSIDE the list's flow in a portal, so the dragged
 * thing can never paint over its neighbours — which is the entire defect. The
 * vacated slot is styled separately by `vacatedSlotClass` below.
 */
export function DragPreview({ children }: { children: React.ReactNode }) {
  return (
    <DragOverlay
      /* A slight lift, so the preview reads as picked up rather than as a copy
         that failed to move. Matches board-view, which already looked right. */
      className="pointer-events-none"
      dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}
    >
      {children}
    </DragOverlay>
  );
}

/**
 * What the ORIGINAL slot looks like while its content floats above (#409 AC3).
 *
 * A dimmed outline rather than an empty gap: a blank row reads as "something
 * broke and the row vanished", which is the confusion this ticket is about. The
 * slot must still occupy its space so the list does not reflow under the pointer.
 */
export function vacatedSlotClass(isDragging: boolean): string {
  return cn(
    isDragging &&
      'opacity-40 outline-1 outline-dashed outline-[var(--border-strong)] outline-offset-[-2px] rounded-[var(--radius-control)]',
  );
}

/**
 * The insertion marker (#412).
 *
 * Derived from `over` — the same value the drop itself resolves against — so it
 * cannot point somewhere a release would not produce. That equivalence is the
 * ticket's requirement, and it is why this takes `overId` rather than a pointer
 * position: a marker computed from geometry can disagree with the drop, and a
 * confident marker that lies is worse than none.
 *
 * Renders nothing when there is no valid target (AC4).
 */
export function DropIndicator({
  active,
  orientation = 'horizontal',
}: {
  /** True when this element is the current `over` target. */
  active: boolean;
  /** `horizontal` = a line BETWEEN rows; `vertical` = between columns. */
  orientation?: 'horizontal' | 'vertical';
}) {
  if (!active) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute z-20 bg-[var(--accent)]',
        orientation === 'horizontal' ? 'inset-x-0 -top-px h-0.5' : 'inset-y-0 -left-px w-0.5',
      )}
    />
  );
}
