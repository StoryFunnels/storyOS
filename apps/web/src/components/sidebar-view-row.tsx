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
import { cn } from '@/lib/utils';

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
}: {
  ws: string;
  view: SidebarView;
  active: boolean;
  folders: FolderChoice[];
  onMove?: (viewId: string, folderId: string | null) => void;
  canEdit: boolean;
}) {
  const Icon = VIEW_ICON[view.type as keyof typeof VIEW_ICON] ?? Table2;

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
    <div
      className={cn(
        'group flex items-center justify-between rounded px-2 py-[3px] text-[13px]',
        active
          ? 'bg-active text-ink shadow-[inset_2px_0_0_var(--accent)]'
          : 'text-ink-secondary hover:bg-hover',
      )}
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
    </div>
  );
}
