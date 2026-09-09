'use client';

import { useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  FormInput,
  GanttChart,
  Group,
  Kanban,
  LayoutDashboard,
  LayoutGrid,
  List as ListIcon,
  Newspaper,
  Pencil,
  Pin,
  Share2,
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
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { ViewSummary, useViewMutations } from './use-view-state';
import { GroupByFieldSelect } from './view-toolbar';
import type { Field } from '../table-view/use-table-data';

/**
 * #347 — exported so the SIDEBAR draws a view with the same icon its tab does.
 * A second map here is how the two drift; field-surfaces doctrine, applied to
 * views rather than fields.
 */
export const VIEW_ICON = {
  board: Kanban,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  list: ListIcon,
  feed: Newspaper,
  timeline: GanttChart,
  form: FormInput,
  dashboard: LayoutDashboard,
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
  fields,
  onNavigate,
  onDelete,
  onDuplicated,
  onShare,
}: {
  view: ViewSummary;
  isActive: boolean;
  canManage: boolean;
  canDelete: boolean;
  mutations: ReturnType<typeof useViewMutations>;
  /** #515 — only needed for board/list views, to offer "Change grouping…". */
  fields: Field[];
  onNavigate: () => void;
  onDelete: () => void;
  onDuplicated: (id: string) => void;
  /** #527 — absent for view types the public page can't render yet (#555:
   *  board/dashboard need backend support the public endpoint doesn't have). */
  onShare?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const [regrouping, setRegrouping] = useState(false);
  const [groupDraft, setGroupDraft] = useState(view.config.group_by_field_id ?? '');
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
            className="h-5 w-28 px-1 py-0 text-[13px]"
          />
        </span>
      ) : (
        <button
          className={cn('flex items-center gap-1.5', canManage && 'touch-none')}
          onClick={onNavigate}
          type="button"
          {...(canManage ? { ...sortable.attributes, ...sortable.listeners } : {})}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="whitespace-nowrap">{view.name}</span>
          {view.isDefault && <Pin className="h-3 w-3 text-faint" aria-label="Default view" />}
        </button>
      )}

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
            {/* #515 — the only way to change WHICH field an existing board/list
                groups by; previously that was set once at creation, never after. */}
            {(view.type === 'board' || view.type === 'list') && (
              <DropdownMenuItem
                onSelect={() => {
                  setGroupDraft(view.config.group_by_field_id ?? '');
                  setRegrouping(true);
                }}
              >
                <Group className="mr-2 h-3.5 w-3.5" />
                Change grouping…
              </DropdownMenuItem>
            )}
            {!view.isDefault && (
              <DropdownMenuItem onSelect={() => mutations.setDefaultView.mutate(view.id)}>
                <Check className="mr-2 h-3.5 w-3.5" />
                Set as default
              </DropdownMenuItem>
            )}
            {/*
              #527 — never offered for a PERSONAL view (view.ownerUserId set):
              a personal view is a private window onto shared data, and #554
              found the server's own share/unshare guard does not check
              ownership at all. Hiding this is a client-side courtesy only —
              it does not fix #554 — but there's no reason to make the gap
              easier to hit from the UI while the real fix is still open.
            */}
            {onShare && !view.ownerUserId && (
              <DropdownMenuItem onSelect={onShare}>
                <Share2 className="mr-2 h-3.5 w-3.5" />
                Share…
              </DropdownMenuItem>
            )}
            {/*
              #293 — fork a SHARED view into a private personal copy, never
              sync'd back (personal-space.md's answer to "publishing is
              one-way"). Never offered for a view that's already personal —
              its owner reaches "publish" from personal-section.tsx instead,
              which this tab-bar never renders a personal view into.
            */}
            {!view.ownerUserId && (
              <DropdownMenuItem onSelect={() => mutations.copyViewToPersonal.mutate(view.id)}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy to My Space
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
      {(view.type === 'board' || view.type === 'list') && (
        <Dialog open={regrouping} onOpenChange={setRegrouping}>
          {regrouping && (
            <DialogContent title={`Change grouping — "${view.name}"`}>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`regroup-${view.id}`}>
                    Group by{view.type === 'list' ? ' (optional)' : ''}
                  </Label>
                  <GroupByFieldSelect
                    id={`regroup-${view.id}`}
                    viewType={view.type}
                    fields={fields}
                    value={groupDraft}
                    onChange={setGroupDraft}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    type="button"
                    disabled={view.type === 'board' && !groupDraft}
                    onClick={() => {
                      const isDateField = fields.find((f) => f.id === groupDraft)?.type === 'date';
                      mutations.regroupView.mutate(
                        { id: view.id, config: view.config, groupByFieldId: groupDraft, isDateField },
                        { onSuccess: () => setRegrouping(false) },
                      );
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </DialogContent>
          )}
        </Dialog>
      )}
    </div>
  );
}
