'use client';

import { useMemo, useRef, useState } from 'react';
import { ArrowUpDown, GripVertical, ListFilter, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ChangeTypeDialog } from './change-type-dialog';
import { EditFieldDialog } from './edit-field-dialog';
import { useDeleteField } from './field-dialog-shared';
import type { Field } from './use-table-data';
import { OPS_BY_TYPE, SORTABLE, defaultValueFor } from '../views/view-toolbar';
import type { ViewConfig } from '../views/use-view-state';
import { buildFilterGroup, filterConditions, filterConnector } from '../views/filter-config';
import { MAX_SORTS, isSortableFormula } from '../views/sort-config';

export function HeaderCell({
  ws,
  db,
  field,
  fields,
  width,
  readOnly,
  onResize,
  stickyZ,
  reorderable = false,
  sticky = false,
  stickyLeft,
  isFirst = false,
  pinned = false,
  onTogglePin,
  onAddLookup,
  config,
  onPatch,
}: {
  ws: string;
  db: string;
  field: Field;
  /** MN-260: the view's full field list, so a formula column's "Sort by this
   * field" can be gated the same way the toolbar's sort builder gates it
   * (isSortableFormula needs to see what the formula depends on). */
  fields: Field[];
  width: number;
  readOnly: boolean;
  onResize: (width: number) => void;
  onAddLookup?: (relationFieldId: string) => void;
  reorderable?: boolean;
  sticky?: boolean;
  stickyLeft?: number;
  stickyZ?: number;
  isFirst?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** View config + patch, so the header menu can filter/sort by this field (MN-225). */
  config?: ViewConfig;
  onPatch?: (updates: Partial<ViewConfig>) => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const canManage = !readOnly && field.type !== 'title' && !field.isSystem;
  const sortable = useSortable({ id: field.id, disabled: !reorderable });

  // Header ⋯ menu: seed a filter clause for this field (MN-225), mirroring AddFilterButton.
  const canFilter = Boolean(config && onPatch && OPS_BY_TYPE[field.type]);
  function filterByField() {
    if (!config || !onPatch) return;
    const first = OPS_BY_TYPE[field.type]?.[0];
    if (!first) return;
    const connector = filterConnector(config.filters);
    const existing = filterConditions(config.filters);
    onPatch({
      filters: buildFilterGroup(connector, [
        ...existing,
        { field: field.apiName, op: first.op, value: defaultValueFor(first.input) },
      ]),
    });
  }

  // Header ⋯ menu: cycle this field's sort asc → desc → none, capped at MAX_SORTS
  // (MN-225; the cap and the seeded default now live in sort-config.ts, MN-252,
  // shared with the toolbar's sort builder rather than duplicated here).
  const byApiName = useMemo(() => new Map(fields.map((f) => [f.apiName, f])), [fields]);
  const canSort = Boolean(
    config && onPatch && SORTABLE.has(field.type) && isSortableFormula(field, byApiName),
  );
  const currentSort = config?.sorts.find((s) => s.field === field.apiName);
  const sortLabel = !currentSort
    ? 'Sort by this field'
    : currentSort.direction === 'asc'
      ? 'Sorted ascending — click for descending'
      : 'Sorted descending — click to clear';
  function sortByField() {
    if (!config || !onPatch) return;
    const sorts = config.sorts;
    if (!currentSort) {
      if (sorts.length >= MAX_SORTS) {
        toast.error(`A view can sort by at most ${MAX_SORTS} fields`);
        return;
      }
      onPatch({ sorts: [...sorts, { field: field.apiName, direction: 'asc' }] });
    } else if (currentSort.direction === 'asc') {
      onPatch({ sorts: sorts.map((s) => (s.field === field.apiName ? { ...s, direction: 'desc' } : s)) });
    } else {
      onPatch({ sorts: sorts.filter((s) => s.field !== field.apiName) });
    }
  }

  const style: React.CSSProperties = {
    width,
    transform: reorderable ? CSS.Transform.toString(sortable.transform) : undefined,
    transition: reorderable ? sortable.transition : undefined,
    ...(sticky ? { position: 'sticky', left: stickyLeft, zIndex: stickyZ ?? 30 } : {}),
  };

  return (
    <div
      ref={reorderable ? sortable.setNodeRef : undefined}
      style={style}
      className={cn(
        'group/header relative flex h-8 shrink-0 items-center justify-between border-r border-border-default px-2 text-[12px] font-medium text-muted',
        sticky && 'bg-app shadow-[2px_0_4px_-2px_rgba(15,23,41,0.12)]',
        sortable.isDragging && 'z-40 opacity-70',
      )}
    >
      {/* The whole name is the drag handle, not just the (hover-only) grip icon —
          a 12px opacity-0 grip was too hard to grab, so reorder felt broken (MN-225). */}
      <span
        className={cn('flex min-w-0 items-center gap-1', reorderable && 'cursor-grab touch-none')}
        {...(reorderable ? sortable.attributes : {})}
        {...(reorderable ? sortable.listeners : {})}
        title={reorderable ? 'Drag to reorder' : undefined}
      >
        {reorderable && (
          <GripVertical className="-ml-1 h-3 w-3 shrink-0 text-faint opacity-0 group-hover/header:opacity-100" />
        )}
        <span className="truncate">{field.displayName}</span>
      </span>
      {isFirst && onTogglePin && (
        <button
          className="rounded p-0.5 text-faint opacity-0 hover:bg-active hover:text-ink group-hover/header:opacity-100"
          title={pinned ? 'Unfreeze column' : 'Freeze column'}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded p-0.5 opacity-0 hover:bg-active group-hover/header:opacity-100">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit field</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('change-type')}>Change type</DropdownMenuItem>
            {field.type === 'relation' && onAddLookup && (
              <DropdownMenuItem onSelect={() => onAddLookup(field.id)}>Add field from linked records</DropdownMenuItem>
            )}
            {canFilter && (
              <DropdownMenuItem onSelect={filterByField}>
                <ListFilter className="mr-2 h-3.5 w-3.5" /> Filter by this field
              </DropdownMenuItem>
            )}
            {canSort && (
              <DropdownMenuItem onSelect={sortByField}>
                <ArrowUpDown className="mr-2 h-3.5 w-3.5" /> {sortLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-error" onSelect={() => deleteField.mutate()}>
              Delete field
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'edit' && (
          <EditFieldDialog
            ws={ws}
            db={db}
            field={field}
            onDone={() => setDialog(null)}
            onChangeType={() => setDialog('change-type')}
          />
        )}
        {dialog === 'change-type' && (
          <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />
        )}
      </Dialog>
      <div
        className="absolute -right-0.5 top-0 z-40 h-full w-1.5 cursor-col-resize hover:bg-accent"
        onPointerDown={(e) => {
          // Keep the resize gesture off the reorder sensor and any header-level
          // click/sort handler — a drag on the handle is only ever a resize (MN-225).
          e.stopPropagation();
          startRef.current = { x: e.clientX, width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => {
          if (!startRef.current) return;
          onResize(Math.max(48, startRef.current.width + (e.clientX - startRef.current.x)));
        }}
        onPointerUp={() => {
          startRef.current = null;
        }}
      />
    </div>
  );
}
