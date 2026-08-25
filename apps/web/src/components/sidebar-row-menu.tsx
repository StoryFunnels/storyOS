'use client';

import { Fragment } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * #383 — the ONE place that owns a sidebar row's … menu.
 *
 * The same defect shipped twice for the same reason. `DatabaseRow` (older) has a
 * full menu; the document row has one; but folders and view rows both arrived
 * with #347 and neither inherited one. The view row got a menu that existed only
 * when `folders.length > 0 || view.folder_id` — so whether a dashboard could be
 * managed depended on whether an unrelated feature was in use — and its entire
 * contents were move-to-folder entries, no rename, no delete. The folder row got
 * no menu at all.
 *
 * That is exactly the mechanism #380 documents for indentation: behaviour living
 * per row component means the component written NEXT does not get it. So the
 * menu lives here, and a new row type gets one by construction.
 *
 * The gating rule is the one thing a caller must not re-invent: a row that can
 * be edited has a menu. Never conditional on what the menu happens to contain —
 * that coupling is the bug.
 */
export interface SidebarMenuAction {
  label: string;
  onSelect: () => void;
  /** Renders in the danger colour. Destructive actions still confirm themselves. */
  danger?: boolean;
  /** Draws a separator above this item (suppressed when it would come first). */
  separatorBefore?: boolean;
}

export function SidebarRowMenu({
  label,
  actions,
}: {
  /** Names the row in the trigger's accessible label. */
  label: string;
  actions: SidebarMenuAction[];
}) {
  // Nothing to offer — render nothing rather than an empty popover.
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          /**
           * `focus:opacity-100` matters as much as the hover: the trigger is
           * invisible until hovered, so without it a keyboard user tabs onto a
           * control they cannot see.
           */
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Options for ${label}`}
          // The row is usually a link or a toggle; opening the menu must not
          // also navigate or collapse it.
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actions.map((action, i) => (
          <Fragment key={action.label}>
            {action.separatorBefore && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={action.onSelect}
              className={action.danger ? 'text-danger focus:text-danger' : undefined}
            >
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
