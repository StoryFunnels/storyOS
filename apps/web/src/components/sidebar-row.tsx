'use client';

import { forwardRef } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import {
  SIDEBAR_INDENT_PX,
  sidebarRowStateClass,
  type SidebarDepth,
} from '@/components/sidebar-row-style';

export { SIDEBAR_INDENT_PX, type SidebarDepth };

const SIDEBAR_ROW_PAD_PX = 8;
const SIDEBAR_HEADER_PAD_PX = 14;

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


/**
 * #805 — the artifact's `.gslot`: every leading glyph (database icon, view
 * type, folder, document, letter mark) sits in ONE 16px centred slot, so a
 * 14px icon and a 16px letter mark both start their label at the same x
 * (58 panel-relative) whatever glyph the row happens to carry. The slot is the
 * mechanism; a row that skips it drifts by a pixel or two, which is exactly
 * the "every icon at one x" defect #779 was filed for.
 */
export function GlyphSlot({ children }: { children: React.ReactNode }) {
  return <span className="flex h-4 w-4 shrink-0 items-center justify-center">{children}</span>;
}

/** The grip gutter is the drag handle for a draggable row without a caret (a
 * caret takes the slot instead), so it gets the "Drag" label; every other
 * gutter is an inert spacer and must not. */
function GutterTip({ enabled, children }: { enabled: boolean; children: React.ReactElement }) {
  return enabled ? (
    <Tooltip label="Drag" side="right">
      {children}
    </Tooltip>
  ) : (
    children
  );
}

export const SidebarRow = forwardRef<HTMLDivElement, {
  depth: SidebarDepth;
  active?: boolean;
  /** Reserves the grip gutter AND renders the grip. */
  draggable?: boolean;
  dragHandleProps?: Record<string, unknown>;
  /**
   * #380 (follow-up) — the disclosure control, rendered INSIDE the reserved gutter.
   *
   * Pass it here rather than as a child. A caret rendered as a child sits BESIDE
   * the gutter and adds its own width, so a row with children ends up indented
   * further than a sibling without — which is exactly the misalignment reported
   * on the Clients/Contacts rows.
   */
  caret?: React.ReactNode;
  /**
   * #412 — the insertion marker shown while a drag is over THIS row.
   *
   * A slot rather than something the row derives, for the same reason `caret` is
   * a slot: the row does not know which drag context it belongs to, and giving
   * it that knowledge is how one shared component turns back into several.
   * Positioned absolutely, so it never affects the row's height or indent.
   */
  indicator?: React.ReactNode;
  /**
   * #805 — where the row's content starts. `row` (default) is the artifact's
   * `.row`: 6px margin + 8px padding, so the hover/active fill is inset from
   * the panel edge. `header` is its `.sp-hd`/`.area-hd`: full-bleed (they are
   * sticky and must be opaque edge to edge) with 14px padding. Both put the
   * chevron slot at x=14 panel-relative.
   */
  edge?: 'row' | 'header';
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>>(function SidebarRow(
  { depth, active = false, draggable = false, dragHandleProps, caret, indicator, edge = 'row', className, style, children, ...rest },
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
      style={{ paddingLeft: (edge === 'header' ? SIDEBAR_HEADER_PAD_PX : SIDEBAR_ROW_PAD_PX) + SIDEBAR_INDENT_PX[depth], ...style }}
      className={cn(
        // `relative` so #412's absolutely-positioned insertion marker anchors to
        // the row rather than escaping to the nearest positioned ancestor.
        // #805 — 24px, not the old ~20 (py-[3px] around a 14px line): the
        // artifact's row height, measured.
        'group relative flex h-6 items-center justify-between rounded pr-2 text-body',
        edge === 'header' ? 'mx-0 pr-3.5' : 'mx-1.5',
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
      {indicator}
      <GutterTip enabled={draggable && !caret}>
      <span
        aria-hidden={!draggable && !caret}
        className={cn(
          'mr-2 flex w-3 shrink-0 justify-center',
          draggable && !caret && 'cursor-grab active:cursor-grabbing',
        )}
        {...(draggable && !caret ? dragHandleProps : {})}
      >
        {/*
          #380 (follow-up) — EXACTLY ONE control occupies this slot, and the slot is always
          12px wide whatever is in it. That is the whole padding system: a row's
          indent is `SIDEBAR_INDENT_PX[depth]` plus one fixed gutter, never a sum
          of whichever controls happen to apply.

          The previous rule reserved the gutter for the grip and let a caret add
          its own width on top, so `Clients` (expandable) sat ~14px right of
          `Contacts` (not) despite being siblings. #380 fixed precisely this for
          folders — by putting the caret IN the gutter — and database rows never
          inherited it. Third time for this mechanism (#380 indentation, #383
          menus, now this), which is why it belongs here rather than in a caller.

          Caret wins over grip when a row has both: expanding is the frequent,
          discoverable action, while dragging is available from the row body
          itself (#322).
        */}
        {caret ?? (draggable ? (
          <GripVertical className="h-3 w-3 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        ) : (
          <span className="block h-3 w-3" />
        ))}
      </span>
      </GutterTip>
      {children}
    </div>
  );
});
