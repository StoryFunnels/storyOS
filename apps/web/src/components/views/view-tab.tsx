'use client';
import { Tooltip } from '@/components/ui/tooltip';

import { useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  FormInput,
  GanttChart,
  LayoutGrid,
  List as ListIcon,
  Pin,
  Star,
  Table2,
  X,
  createLucideIcon,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ViewSummary, useViewMutations } from './use-view-state';
import { buildViewMenu } from './view-menu';
import type { ViewMenuHandlers } from './view-menu';
import { ViewMenuItems } from './view-menu-items';

/**
 * #970 — three glyphs redrawn because they fail at 14px, the only size the sidebar and tabs draw
 * (decision sheet: https://claude.ai/artifact/LCe3CHKSqx9yo4mgdoJwEx). Built with lucide's own factory,
 * so they take the same props and default stroke as the six lucide icons beside them.
 * - dashboard: LayoutDashboard is four rectangles, the same glyph as gallery's LayoutGrid. One framed
 *   surface split unevenly differs structurally.
 * - feed: Newspaper is a smudge at 14px. A feed is stacked full-width cards: two rectangles.
 * - board: Kanban's bare strokes read as a bar chart; three columns go solid at 14px. Two columns of
 *   unequal height stay open and still say "columns".
 */
const BoardIcon = createLucideIcon('view-board', [
  ['rect', { x: '3.5', y: '4.5', width: '7.5', height: '15', rx: '1.8', key: 'b1' }],
  ['rect', { x: '13', y: '4.5', width: '7.5', height: '11', rx: '1.8', key: 'b2' }],
]);
const DashboardIcon = createLucideIcon('view-dashboard', [
  ['rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '2.4', key: 'd1' }],
  ['path', { d: 'M11.5 4.5v15M11.5 12h9.5', key: 'd2' }],
]);
const FeedIcon = createLucideIcon('view-feed', [
  ['rect', { x: '3', y: '4', width: '18', height: '6.6', rx: '1.8', key: 'f1' }],
  ['rect', { x: '3', y: '13.4', width: '18', height: '6.6', rx: '1.8', key: 'f2' }],
]);

/**
 * #347 — exported so the SIDEBAR draws a view with the same icon its tab does.
 * A second map here is how the two drift; field-surfaces doctrine, applied to
 * views rather than fields. The tabs, sidebar, switcher and New view dialog all read it.
 */
export const VIEW_ICON = {
  board: BoardIcon,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  list: ListIcon,
  feed: FeedIcon,
  timeline: GanttChart,
  form: FormInput,
  dashboard: DashboardIcon,
  table: Table2,
} as const;

/**
 * A view tab (MN-241): navigate on click; a caret menu offers rename (inline),
 * duplicate, set-as-default, and delete — gated by edit permission. The default
 * view is marked with a pin.
 */
export function ViewTab({
  view,
  isActive,
  canManage,
  canDelete,
  mutations,
  onNavigate,
  onDelete,
  onDuplicated,
  onShare,
  onCopyLink,
  moves,
  pinned,
  onSetPinned,
}: {
  view: ViewSummary;
  isActive: boolean;
  canManage: boolean;
  canDelete: boolean;
  mutations: ReturnType<typeof useViewMutations>;
  onNavigate: () => void;
  onDelete: () => void;
  onDuplicated: (id: string) => void;
  /** #527 — absent for view types the public page can't render yet (#555:
   *  board/dashboard need backend support the public endpoint doesn't have). */
  onShare?: () => void;
  /** #964 — the shared view menu's "Copy link" and "Move to…" entries, supplied by the page. */
  onCopyLink?: () => void;
  moves?: ViewMenuHandlers['moves'];
  /** #966 — this tab is in the viewer's own strip. False for the active view shown only because it is active. */
  pinned: boolean;
  /** #966 — pin or unpin for THIS viewer. */
  onSetPinned: (wanted: boolean) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  // #927 — the options menu is also opened by right-clicking the tab, so it is reachable without finding the chevron.
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const Icon = VIEW_ICON[view.type] ?? Table2;
  // Only editors may reorder; renaming (inline input) also suspends the drag.
  // #966 — a drag reorders YOUR pinned tabs, so it needs no edit permission; the transient active tab cannot be moved.
  const sortable = useSortable({ id: view.id, disabled: !pinned || renaming });

  // #964 — the ONE view menu (view-menu.ts), shared with the toolbar ⋯ and the sidebar ⋯. This tab is
  // two of its doors: the chevron, and a right-click or long-press anywhere on the tab (#927).
  const menuItems = buildViewMenu(
    {
      name: view.name,
      isDefault: Boolean(view.isDefault),
      personal: Boolean(view.ownerUserId),
      pinned,
    },
    {
      canManage,
      canDelete,
      onRename: () => {
        setDraft(view.name);
        setRenaming(true);
      },
      onDuplicate: () =>
        mutations.duplicateView.mutate(view.id, { onSuccess: (v) => onDuplicated(v.id) }),
      onSetDefault: () => mutations.setDefaultView.mutate(view.id),
      onSetPinned,
      onCopyLink,
      onShare,
      onCopyToPersonal: () => mutations.copyViewToPersonal.mutate(view.id),
      moves,
      onDelete,
    },
  );

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== view.name) mutations.renameView.mutate({ id: view.id, name });
    else setDraft(view.name);
  }

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      onContextMenu={(e) => {
        if (menuItems.length === 0 || renaming) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        // #994 — the prototype's `.tab`: 30px tall, 11px side padding, 12px label, rounded on top only; the active tab is
        // a white card with a hairline on its top and sides (the strip's own line closes the bottom), weight 650.
        'group/tab flex h-[30px] shrink-0 items-center gap-1.5 rounded-t-[var(--radius-control)] px-[11px] text-label',
        isActive
          ? 'bg-card font-[650] text-ink shadow-[inset_0_1px_0_var(--border-default),inset_1px_0_0_var(--border-default),inset_-1px_0_0_var(--border-default)]'
          : 'text-muted hover:bg-hover hover:text-ink',
        sortable.isDragging && 'z-10 opacity-70',
      )}
    >
      {renaming ? (
        // The rename input must NOT live inside the navigate <button>: pressing
        // Space in a text field nested in a button bubbled up and activated the
        // button, navigating away (the "page refresh" while renaming). Rendered
        // standalone here, and keydown is stopped so no ancestor/global shortcut
        // handler reacts to Space either.
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" />
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(view.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-5 w-28 px-1 py-0 text-body"
          />
        </span>
      ) : (
        <button
          className={cn('flex items-center gap-1.5', pinned && 'touch-none')}
          onClick={onNavigate}
          type="button"
          {...(pinned ? { ...sortable.attributes, ...sortable.listeners } : {})}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="whitespace-nowrap">{view.name}</span>
          {view.isDefault && <Pin className="h-3 w-3 text-faint" aria-label="Default view" />}
        </button>
      )}

      {/* #966 / #900 — no hover-only control in the strip. The ACTIVE tab carries two real controls that rest
          visible at --faint: unpin (✕) when it is one of your pins, or pin (star) when it is only shown because it
          is active; and its options chevron. Every OTHER tab opens the same view menu from a right-click or a
          long-press, and from the switcher, so nothing here waits for a pointer to hover. */}
      {isActive && !renaming && (
        <button
          type="button"
          onClick={() => onSetPinned(!pinned)}
          aria-label={pinned ? `Unpin ${view.name} from tabs` : `Pin ${view.name} to tabs`}
          title={pinned ? 'Unpin from tabs' : 'Pin to tabs'}
          className="rounded p-1 text-faint hover:bg-active hover:text-ink"
        >
          {pinned ? <X className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
        </button>
      )}
      {menuItems.length > 0 && !renaming && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip label="View options">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                // Inactive tabs keep the trigger out of the way (it is the right-click / long-press target, and
                // the menu is one tap from the switcher), but it is never opacity-0-until-hover: it is simply
                // not drawn, so a touch user is never promised a control that only a mouse can reveal.
                className={cn(
                  'rounded p-1 text-muted hover:bg-active hover:text-ink',
                  !isActive && 'sr-only',
                )}
                onClick={(e) => e.stopPropagation()}
                aria-label="View options"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            <ViewMenuItems items={menuItems} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
