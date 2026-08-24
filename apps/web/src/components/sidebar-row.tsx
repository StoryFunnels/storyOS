'use client';

import { forwardRef } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SIDEBAR_INDENT_PX,
  sidebarRowStateClass,
  type SidebarDepth,
} from '@/components/sidebar-row-style';

export { SIDEBAR_INDENT_PX, type SidebarDepth };

/**
 * #380 — the ONE place that owns sidebar row geometry.
 *
 * Depth used to be an accident of layout rather than a decision. Every row
 * declared the same `px-2 py-[3px]`, and the real indent came from a drag-grip
 * that only SOME rows reserved: `DatabaseRow` rendered a `GripVertical` which
 * occupies layout even at `opacity-0`, pushing its icon ~10px right. #219 fixed
 * documents by copying an invisible spacer into the document row — and then
 * #347 added view rows, which reserved nothing, and the same bug came back.
 *
 * A fix that lives as a copied spacer in one component cannot protect the
 * component written after it. So the gutter is reserved HERE, by the wrapper,
 * and a new row type gets it by construction. That matters immediately: #368
 * and #369 both add or move row types.
 */


export const SidebarRow = forwardRef<HTMLDivElement, {
  depth: SidebarDepth;
  active?: boolean;
  /** Reserves the grip gutter AND renders the grip. */
  draggable?: boolean;
  dragHandleProps?: Record<string, unknown>;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>>(function SidebarRow(
  { depth, active = false, draggable = false, dragHandleProps, className, style, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      /**
       * Caller styles are MERGED, never allowed to replace this. A draggable row
       * passes `{transform, transition}` from dnd-kit, and spreading that over
       * the whole style object would silently drop the indent — the row would
       * lose its depth only while sortable, which is exactly the kind of
       * conditional geometry bug this component exists to end.
       */
      style={{ paddingLeft: SIDEBAR_INDENT_PX[depth], ...style }}
      className={cn(
        'group flex items-center justify-between rounded pr-2 py-[3px] text-[13px]',
        /**
         * #380 — BACKGROUND ONLY for the active row.
         *
         * There used to be an amber inset bar as well
         * (`shadow-[inset_2px_0_0_var(--accent)]`), applied per row type — so a
         * database and the "All records" child it opens were both active and you
         * got TWO stacked bars for ONE location. Two markers, one place.
         */
        sidebarRowStateClass(active),
        className,
      )}
      {...rest}
    >
      {/*
        The gutter is reserved whether or not this row is draggable, so icons
        line up vertically within a depth — draggable or not, hovered or not.
        Rendering it only on hover is what made rows shift under the cursor.
      */}
      <span
        aria-hidden={!draggable}
        className={cn('mr-0.5 flex w-3 shrink-0 justify-center', draggable && 'cursor-grab active:cursor-grabbing')}
        {...(draggable ? dragHandleProps : {})}
      >
        {draggable ? (
          <GripVertical className="h-3 w-3 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        ) : (
          <span className="block h-3 w-3" />
        )}
      </span>
      {children}
    </div>
  );
});
