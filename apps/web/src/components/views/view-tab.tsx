'use client';

import { useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  FormInput,
  GanttChart,
  Kanban,
  LayoutGrid,
  List as ListIcon,
  Newspaper,
  Pencil,
  Pin,
  Table2,
  Trash2,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ViewSummary, useViewMutations } from './use-view-state';

const VIEW_ICON = {
  board: Kanban,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  list: ListIcon,
  feed: Newspaper,
  timeline: GanttChart,
  form: FormInput,
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
}: {
  view: ViewSummary;
  isActive: boolean;
  canManage: boolean;
  canDelete: boolean;
  mutations: ReturnType<typeof useViewMutations>;
  onNavigate: () => void;
  onDelete: () => void;
  onDuplicated: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const Icon = VIEW_ICON[view.type] ?? Table2;
  // Only editors may reorder; renaming (inline input) also suspends the drag.
  const sortable = useSortable({ id: view.id, disabled: !canManage || renaming });

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== view.name) mutations.renameView.mutate({ id: view.id, name });
    else setDraft(view.name);
  }

  return (
    <div
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={cn(
        'group/tab flex items-center gap-1 rounded px-2 py-1 text-[13px]',
        isActive ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink',
        sortable.isDragging && 'z-10 opacity-70',
      )}
    >
      <button
        className={cn('flex items-center gap-1.5', canManage && !renaming && 'touch-none')}
        onClick={onNavigate}
        type="button"
        {...(canManage && !renaming ? { ...sortable.attributes, ...sortable.listeners } : {})}
      >
        <Icon className="h-3.5 w-3.5" />
        {renaming ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(view.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-5 w-28 px-1 py-0 text-[13px]"
          />
        ) : (
          <span className="whitespace-nowrap">{view.name}</span>
        )}
        {view.isDefault && <Pin className="h-3 w-3 text-faint" aria-label="Default view" />}
      </button>

      {canManage && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'rounded p-0.5 text-faint hover:bg-active hover:text-ink',
                isActive ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-100',
              )}
              onClick={(e) => e.stopPropagation()}
              aria-label="View options"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(view.name);
                setRenaming(true);
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                mutations.duplicateView.mutate(view.id, { onSuccess: (v) => onDuplicated(v.id) })
              }
            >
              <Copy className="mr-2 h-3.5 w-3.5" />
              Duplicate
            </DropdownMenuItem>
            {!view.isDefault && (
              <DropdownMenuItem onSelect={() => mutations.setDefaultView.mutate(view.id)}>
                <Check className="mr-2 h-3.5 w-3.5" />
                Set as default
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-error" onSelect={onDelete}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
