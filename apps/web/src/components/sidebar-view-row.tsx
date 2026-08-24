'use client';

import Link from 'next/link';
import { MoreHorizontal, Table2, Lock } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { VIEW_ICON } from '@/components/views/view-tab';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SidebarRow, type SidebarDepth } from '@/components/sidebar-row';

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
  canEdit,
  depth = 2,
}: {
  ws: string;
  view: SidebarView;
  active: boolean;
  folders: FolderChoice[];
  onMove?: (viewId: string, folderId: string | null) => void;
  canEdit: boolean;
  /** #380 — 2 when nested under its database, 1 at the space root. */
  depth?: SidebarDepth;
}) {
  const Icon = VIEW_ICON[view.type as keyof typeof VIEW_ICON] ?? Table2;
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

  const label = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="truncate">{view.name}</span>
      {view.personal && (
        // #291 — badge that it is private. Never say whose: the payload does
        // not carry an owner id, and this must not become the place it leaks.
        <Lock className="h-3 w-3 shrink-0 text-faint" aria-label="Only you can see this view" />
      )}
    </>
  );

  return (
    /**
     * #380 — depth comes from the wrapper now. This component previously
     * reserved NO grip gutter, so a space-level dashboard rendered ~10px LEFT of
     * the databases beside it: #219's fix had been copied into the document row
     * but view rows arrived later (#347) and never inherited it.
     *
     * `depth` is passed by the caller because the same component renders at two
     * levels — nested under a database (2) or at the space root (1).
     */
    <SidebarRow
      depth={depth}
      active={active}
      ref={canEdit ? setNodeRef : undefined}
      style={canEdit ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      draggable={canEdit}
      dragHandleProps={canEdit ? { ...attributes, ...listeners } : undefined}
      className={isDragging ? 'opacity-50' : undefined}
    >
      {href ? (
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-1.5">
          {label}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{label}</span>
      )}

      {canEdit && onMove && (folders.length > 0 || view.folder_id) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              aria-label={`Options for ${view.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {view.folder_id && (
              <>
                <DropdownMenuItem onSelect={() => onMove(view.id, null)}>
                  Move back under its database
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {folders
              .filter((f) => f.id !== view.folder_id)
              .map((f) => (
                <DropdownMenuItem key={f.id} onSelect={() => onMove(view.id, f.id)}>
                  Move to {f.name}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarRow>
  );
}