'use client';

import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GRID_COLUMNS, blockStyle, clampSpan } from './dashboard-layout';
import type { BlockLayout } from '@storyos/schemas';

/**
 * One block's place on the dashboard grid (#386) — drag to reorder, drag to resize.
 *
 * Both affordances are EDIT-MODE ONLY, which #386 asks for explicitly and #385's
 * reasoning already established: dragging tiles around while reading is how you
 * rearrange a dashboard by accident, and the damage is silent because a layout
 * change looks like nothing went wrong.
 */
export function DashboardBlockShell({
  id,
  layout,
  editing,
  gridRef,
  onResize,
  children,
}: {
  id: string;
  layout: BlockLayout;
  editing: boolean;
  /** The grid element, so a resize can measure a column instead of guessing. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  onResize: (span: { w: number; h: number }) => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  });
  const resizing = useRef(false);

  /**
   * Resize by measuring the GRID, never the block.
   *
   * The block's own width is the thing being changed, so deriving the new span
   * from it makes the input depend on the output — the block grows, the next
   * pointer event reads the grown width, and it runs away or judders. The grid's
   * width is fixed for the duration of the drag, so one column is a constant and
   * the span is a pure function of the pointer.
   */
  function startResize(e: React.PointerEvent) {
    const grid = gridRef.current;
    if (!grid) return;
    e.preventDefault();
    e.stopPropagation();
    const gridRect = grid.getBoundingClientRect();
    const blockRect = (e.currentTarget as HTMLElement).closest('[data-block]')!.getBoundingClientRect();
    // The gap is part of a column's pitch; without it a 12-span drag lands short
    // by 11 gaps and the last column is unreachable.
    const gap = parseFloat(getComputedStyle(grid).columnGap || '0') || 0;
    const colPitch = (gridRect.width + gap) / GRID_COLUMNS;
    const rowPitch = blockRect.height / Math.max(1, layout.h);
    const left = blockRect.left;
    const top = blockRect.top;

    resizing.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      if (!resizing.current) return;
      const next = clampSpan((ev.clientX - left + gap) / colPitch, (ev.clientY - top) / rowPitch);
      if (next.w !== layout.w || next.h !== layout.h) onResize(next);
    };
    const end = () => {
      resizing.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  return (
    <div
      ref={setNodeRef}
      data-block={id}
      style={{
        ...blockStyle(layout),
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn('relative min-w-0', isDragging && 'z-10 opacity-60')}
    >
      {children}

      {editing && (
        <>
          {/*
            A dedicated grip rather than making the whole card draggable. The card
            is full of inputs, selects and a filter builder in edit mode — the one
            state where dragging is possible — so a card-wide drag surface would
            fight every one of them for the pointer.
          */}
          <button
            type="button"
            aria-label="Drag to reorder"
            title="Drag to reorder"
            className="absolute left-1 top-1 cursor-grab rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-ink focus:opacity-100 group-hover:opacity-100 active:cursor-grabbing [div[data-block]:hover_&]:opacity-100"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>

          <div
            role="slider"
            tabIndex={0}
            aria-label="Resize block"
            aria-valuenow={layout.w}
            aria-valuemin={1}
            aria-valuemax={GRID_COLUMNS}
            onPointerDown={startResize}
            /* Keyboard resize, because a pointer-only affordance is not an
               affordance for everyone — and it is four lines. */
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') onResize(clampSpan(layout.w + 1, layout.h));
              if (e.key === 'ArrowLeft') onResize(clampSpan(layout.w - 1, layout.h));
              if (e.key === 'ArrowDown') onResize(clampSpan(layout.w, layout.h + 1));
              if (e.key === 'ArrowUp') onResize(clampSpan(layout.w, layout.h - 1));
            }}
            title="Drag to resize"
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-br-[var(--radius-control)] opacity-0 hover:opacity-100 focus:opacity-100 [div[data-block]:hover_&]:opacity-60"
            style={{
              background:
                'linear-gradient(135deg, transparent 50%, var(--border-default) 50%, var(--border-default) 70%, transparent 70%)',
            }}
          />
        </>
      )}
    </div>
  );
}
