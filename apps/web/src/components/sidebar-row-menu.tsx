'use client';

import { Fragment } from 'react';
import Link from 'next/link';
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
/**
 * #389 — widened to what `DatabaseRow` actually needs, so ALL sidebar rows can
 * share one menu.
 *
 * #383 deliberately left `DatabaseRow` on its own markup: its menu is richer
 * (per-item icons, a "Move to" section header, an `asChild` link, admin-gated
 * items) and #383 was Urgent because dashboards could not be deleted at all —
 * refactoring a working menu under an urgent fix would have been the wrong
 * trade. This is that refactor, done separately.
 *
 * Every field below exists because a real call site needed it. A menu shape
 * invented ahead of its callers is how the two definitions drifted in the first
 * place.
 */
export interface SidebarMenuAction {
  label: string;
  /** Omitted for an `href` item, which navigates instead. */
  onSelect?: () => void;
  /** Renders in the danger colour. Destructive actions still confirm themselves. */
  danger?: boolean;
  /** Draws a separator above this item (suppressed when it would come first). */
  separatorBefore?: boolean;
  /** #389 — optional leading icon, e.g. the folder glyph on a "Move to" target. */
  icon?: React.ReactNode;
  /**
   * #389 — a non-interactive section heading rendered ABOVE this item.
   * `DatabaseRow`'s "Move to" group; not a menu item, so it cannot be focused.
   */
  sectionLabel?: string;
  /**
   * #389 — renders through `asChild` as a link (DatabaseRow's Trash entry).
   * A real anchor, so middle-click and open-in-new-tab behave.
   */
  href?: string;
  /**
   * #389 — drop this item entirely.
   *
   * Exists so a caller writes `hidden: !isAdmin` in place rather than building
   * conditional arrays with spreads and `.filter(Boolean)` — that pattern is
   * where an item quietly disappears for everyone because a spread landed in
   * the wrong branch.
   */
  hidden?: boolean;
}

export function SidebarRowMenu({
  label,
  actions,
  contentClassName,
}: {
  /** Names the row in the trigger's accessible label. */
  label: string;
  actions: SidebarMenuAction[];
  /** Width override; the default suits short action lists. */
  contentClassName?: string;
}) {
  // `hidden` is applied HERE, not by the caller, so "how many items are there"
  // is asked of the visible list — an all-hidden menu renders nothing rather
  // than an empty popover.
  const visible = actions.filter((a) => !a.hidden);
  if (visible.length === 0) return null;
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
      <DropdownMenuContent align="end" className={contentClassName ?? 'w-52'}>
        {visible.map((action, i) => (
          <Fragment key={action.label}>
            {action.separatorBefore && i > 0 && <DropdownMenuSeparator />}
            {action.sectionLabel && (
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
                {action.sectionLabel}
              </div>
            )}
            {action.href ? (
              <DropdownMenuItem asChild>
                <Link href={action.href}>
                  {action.icon}
                  {action.label}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={action.onSelect}
                className={action.danger ? 'text-error focus:text-error' : undefined}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
