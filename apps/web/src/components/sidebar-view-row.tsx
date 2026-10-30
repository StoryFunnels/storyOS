'use client';

import Link from 'next/link';
import { Database, Table2, Star } from 'lucide-react';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';
import { buildViewMenu } from '@/components/views/view-menu';
import { useViewMenuActions, viewMenuSidebarActions } from '@/components/views/view-menu-items';
import { VIEW_ICON } from '@/components/views/view-tab';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GlyphSlot, SidebarRow, type SidebarDepth } from '@/components/sidebar-row';
import { usePrefetchDatabase } from '@/components/table-view/use-table-data';
import { EntityIcon } from '@/components/ui/icon-picker';
import { databaseColor } from '@/lib/entity-color';
import { useDatabases } from '@/lib/queries';
import { sourceMarks } from '@/lib/sidebar-source-marks';

/**
 * #347 — a VIEW as a leaf in the sidebar tree.
 *
 * Placement, not ownership: a view still belongs to its database. `folder_id`
 * null means it renders nested under that database; set means it renders in
 * that folder instead. One home at a time — see
 * docs/architecture/views-and-the-sidebar.md §4.
 */
export interface SidebarView {
  id: string;
  name: string;
  type: string;
  database_id: string | null;
  space_id: string | null;
  folder_id: string | null;
  position: number;
  is_default: boolean;
  personal: boolean;
  /** #1013 — the databases this view reads (a dashboard: its tiles' too); unreadable ones are omitted by the API. */
  source_database_ids?: string[];
}

export interface FolderChoice {
  id: string;
  name: string;
}

export function SidebarViewRow({
  ws,
  view,
  active,
  folders,
  onMove,
  onRename,
  onDelete,
  canEdit,
  depth = 0,
  tint,
}: {
  ws: string;
  view: SidebarView;
  active: boolean;
  folders: FolderChoice[];
  onMove?: (viewId: string, folderId: string | null) => void;
  /** #383 — rename and delete, which this row never offered. */
  onRename?: (view: SidebarView) => void;
  onDelete?: (view: SidebarView) => void;
  canEdit: boolean;
  /** #380/#742 — 0 at the space root or nested under its database (the
   * database-expanded-views wrapper supplies that one step itself); 0 inside
   * a folder too, for the same reason. There is only one real indent step
   * left in the whole tree (SIDEBAR_INDENT_PX[1], a folder's own body), and
   * it always comes from a WRAPPER, never stacked again on the row itself. */
  depth?: SidebarDepth;
  /** #931 — the owning database's colour (a CSS colour), so a view's glyph says where it comes from. */
  tint?: string | null;
}) {
  const Icon = VIEW_ICON[view.type as keyof typeof VIEW_ICON] ?? Table2;
  // #998 — a view of a database opens that database's page: warm its detail before the click.
  const prefetchDatabase = usePrefetchDatabase(ws);
  const warm = view.database_id ? () => prefetchDatabase(view.database_id!) : undefined;
  /**
   * #369 — views are draggable now. They were not, so a view could only be moved
   * through its menu while a database beside it could be dragged: two ways to do
   * one thing, depending on the row type.
   */
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.id,
    data: { kind: 'view' },
    disabled: !canEdit,
  });

  /**
   * A database-owned view stays reachable at `/w/:ws/d/:db?view=` — #347 changed
   * no URLs. A view with no database is addressed by the view-first route #306
   * added, which is the only URL this initiative introduced.
   */
  const href = view.database_id
    ? `/w/${ws}/d/${view.database_id}?view=${view.id}`
    : `/w/${ws}/v/${view.id}`;

  const viewActions = useViewMenuActions(ws, view.database_id);
  const pinned = Boolean(viewActions?.pins.isPinned(view.id));

  // #1013 — a view that reads several databases names them at its right edge (the prototype's `srcMarks`).
  const databases = useDatabases(ws);
  const marks = sourceMarks(
    view.source_database_ids,
    new Map((databases.data ?? []).map((d) => [d.id, { id: d.id, name: d.name, icon: d.icon, color: d.color }])),
  );

  const label = (
    <>
      <GlyphSlot>
        {/* #931 — a lens: a step smaller than a database's glyph, keeping its source colour. */}
        <Icon className="h-3 w-3 text-muted" style={tint ? { color: tint } : undefined} />
      </GlyphSlot>
      <span className="overflow-hidden whitespace-nowrap">{view.name}</span>
      {/* #994 — a view pinned to the viewer's tabs carries a small gold star at the right edge (the prototype's pinned mark). */}
      {pinned && <Star className="h-[11px] w-[11px] shrink-0 text-primary-text" aria-label="Pinned to your tabs" />}
    </>
  );

  // #964 — the ONE view menu (views/view-menu.ts), the same list the toolbar ⋯ and the tab ⋯ show.
  // A space-level view has no database, so it gets the subset that needs none (rename, delete, move).
  const moves = [
    // Only this door knows which folder a view is in, so only it can offer the way back out.
    ...(onMove && view.folder_id
      ? [
          {
            id: 'root',
            label: view.database_id ? 'Move back under its database' : 'Move to the space root',
            onSelect: () => onMove(view.id, null),
          },
        ]
      : []),
    ...(onMove
      ? folders
          .filter((f) => f.id !== view.folder_id)
          .map((f) => ({ id: f.id, label: `Move to ${f.name}`, onSelect: () => onMove(view.id, f.id) }))
      : []),
  ];
  const menuItems = buildViewMenu(
    {
      name: view.name,
      isDefault: view.is_default,
      personal: view.personal,
      pinned: viewActions?.pins.isPinned(view.id),
    },
    {
      canManage: canEdit,
      // The sidebar does not know how many views the database has; the API refuses deleting the last.
      canDelete: true,
      onRename: onRename ? () => onRename(view) : undefined,
      onDuplicate: viewActions ? () => viewActions.duplicate(view.id) : undefined,
      onSetDefault: viewActions ? () => viewActions.setDefault(view.id) : undefined,
      onSetPinned: viewActions ? (wanted) => viewActions.pins.setPinned(view.id, wanted) : undefined,
      onCopyLink: viewActions ? () => void viewActions.copyLink(view.id) : undefined,
      onShare:
        viewActions && (view.type === 'table' || view.type === 'board' || view.type === 'dashboard')
          ? () => viewActions.share(view.id)
          : undefined,
      onCopyToPersonal: viewActions ? () => viewActions.copyToPersonal(view.id) : undefined,
      moves,
      onDelete: onDelete ? () => onDelete(view) : undefined,
    },
  );

  return (
    /**
     * #380 — depth comes from the wrapper now. This component previously
     * reserved NO grip gutter, so a space-level dashboard rendered ~10px LEFT of
     * the databases beside it: #219's fix had been copied into the document row
     * but view rows arrived later (#347) and never inherited it.
     *
     * `depth` is passed by the caller, and it is 0 for every view: a database's views get their
     * one indent step from the guide-line wrapper in `DatabaseBranch` (#931), a folder's from the
     * folder body, and a space-level view is a sibling at the space edge. (The "(2) or (1)" this
     * comment used to describe was the old three-level scale, deleted by #742.)
     */
    <SidebarRow
      depth={depth}
      lens
      active={active}
      ref={canEdit ? setNodeRef : undefined}
      style={canEdit ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      draggable={canEdit}
      dragHandleProps={canEdit ? { ...attributes, ...listeners } : undefined}
      className={isDragging ? 'opacity-50' : undefined}
    >
      {href ? (
        <Link
          href={href}
          title={view.name}
          onPointerEnter={warm}
          onFocus={warm}
          onPointerDown={warm}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {label}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      )}

      {marks && (
        <span
          className="ml-auto flex shrink-0 items-center gap-0.5"
          title={`Reads ${marks.shown.length + marks.more} databases: ${marks.shown.map((d) => d.name).join(', ')}${marks.more > 0 ? ` and ${marks.more} more` : ''}`}
          data-testid="source-marks"
        >
          {marks.shown.map((d) => (
            <span key={d.id} className="flex h-3.5 w-3.5 items-center justify-center text-[13px]" title={d.name}>
              <EntityIcon icon={d.icon} color={databaseColor(d.color, d.id)} fallback={<Database className="h-3 w-3" />} />
            </span>
          ))}
          {marks.more > 0 && <span className="text-[9px] font-bold tabular-nums text-faint">+{marks.more}</span>}
        </span>
      )}

      {/**
        * #383 — gated on `canEdit` ALONE.
        *
        * This used to read `canEdit && onMove && (folders.length > 0 ||
        * view.folder_id)`, so the menu existed only if the space happened to
        * contain a folder: create a folder anywhere and a … appeared on every
        * dashboard, delete it and they all vanished. Whether a dashboard could
        * be managed depended on whether an unrelated feature was in use, and
        * since the menu held nothing but move-to-folder entries, deleting a
        * dashboard was unreachable from the sidebar under every circumstance.
        *
        * Move entries now come and go with the folders; the MENU does not.
        */}
      {menuItems.length > 0 && <SidebarRowMenu label={view.name} actions={viewMenuSidebarActions(menuItems)} />}
    </SidebarRow>
  );
}