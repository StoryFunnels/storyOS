'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  EyeOff,
  FilterX,
  GripVertical,
  ListFilter,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react';
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
import { vacatedSlotClass } from '@/components/ui/drag-presentation';
import { ChangeTypeDialog } from './change-type-dialog';
import { EditFieldDialog } from './edit-field-dialog';
import { useDeleteField } from './field-dialog-shared';
import type { Field } from './use-table-data';
import { OPS_BY_TYPE, SORTABLE, defaultValueFor } from '../views/view-toolbar';
import type { ViewConfig } from '../views/use-view-state';
import {
  buildFilterGroup,
  clearConditionsForField,
  conditionPathsForField,
  filterConditions,
  filterConnector,
} from '../views/filter-config';
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
  // #492 — this used to gate the WHOLE menu's visibility, conflating two
  // different questions: "can I run destructive schema ops on this field"
  // (still exactly this) and "does this column get a menu at all" (now
  // `hasMenu`, below the per-item flags it depends on). A system field
  // answers the first "no" and the second "yes, a reduced one" — the same
  // shape `canConfigureTitle` already gives the title field, generalised
  // rather than copied a third time (the drift this codebase has shipped at
  // least six times: #375/#380/#383/#399/#408/#422).
  const canManage = !readOnly && field.type !== 'title' && !field.isSystem;
  // MN-131: the title field isn't a normal managed field (no delete/change-type),
  // but its name mode (free text ⇆ computed) is configured through the same edit
  // dialog — expose a focused "Configure name…" entry for it.
  const canConfigureTitle = !readOnly && field.type === 'title';
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

  // #224: a filtered column has to SAY so. The menu could already add a filter, but
  // nothing on the header indicated one was active, so a narrowed table read as
  // "the filter silently did nothing". Counts conditions at any depth, and the
  // clear is one action rather than a trip to the toolbar's builder.
  const filteredCount = useMemo(
    () => (config ? conditionPathsForField(filterConditions(config.filters), field.apiName).length : 0),
    [config, field.apiName],
  );
  const isFiltered = filteredCount > 0;
  function clearFilterOnField() {
    if (!config || !onPatch) return;
    const remaining = clearConditionsForField(filterConditions(config.filters), field.apiName);
    onPatch({ filters: buildFilterGroup(filterConnector(config.filters), remaining) });
  }

  // #224 AC3: hide a column from its own header, not only from the toolbar's Fields
  // panel. Writes the same `hidden_field_ids` the toolbar's HiddenFieldsButton owns
  // — one persisted shape, so the two surfaces can't drift (field-surfaces.md).
  const canHide = Boolean(config && onPatch);
  function hideField() {
    if (!config || !onPatch) return;
    if (config.hidden_field_ids.includes(field.id)) return;
    onPatch({ hidden_field_ids: [...config.hidden_field_ids, field.id] });
  }

  // Header ⋯ menu: cycle this field's sort asc → desc → none, capped at MAX_SORTS
  // (MN-225; the cap and the seeded default now live in sort-config.ts, MN-252,
  // shared with the toolbar's sort builder rather than duplicated here).
  const byApiName = useMemo(() => new Map(fields.map((f) => [f.apiName, f])), [fields]);
  const canSort = Boolean(
    config && onPatch && SORTABLE.has(field.type) && isSortableFormula(field, byApiName),
  );
  // #492 — the trigger's own visibility: canManage (destructive ops) OR any of
  // the already-independently-gated safe items. For an ordinary field this is
  // identical to `canManage` alone (canFilter/canSort/canHide are never the
  // ONLY true one there in practice, but even if they were, canManage is
  // already true so the OR is a no-op) — the only field type this actually
  // changes is `isSystem`, which is exactly this ticket's scope. readOnly
  // still hides the menu entirely for every field, unchanged: canManage
  // requires !readOnly, and canFilter/canSort/canHide are independent of
  // readOnly today (a view-level permission, not a schema one) — same as
  // before this change, not something this ticket alters.
  const hasMenu = canManage || canFilter || canSort || canHide;
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
      /*
       * #413 — the WHOLE header is the handle, not the 37px of label text.
       *
       * Measured on the deployed app: for a 180px `Won` column the element
       * carrying the listeners spanned 37px — about 20% — so pressing at the
       * header's natural centre did nothing at all. The first UAT attempt aimed
       * there, got no drag, and had to be re-aimed at the word.
       *
       * `sidebar.tsx` already learned this ("#322: the row itself is the handle,
       * not only the 12px grip — the exact thing header-cell.tsx records as 'too
       * hard to grab, so reorder felt broken'"). This file recorded the lesson
       * and never got the fix.
       *
       * Safe to widen because every control that must NOT start a drag already
       * stops propagation on pointerdown: the resize handle (MN-225) and the
       * dropdown triggers below.
       */
      {...(reorderable ? sortable.attributes : {})}
      {...(reorderable ? sortable.listeners : {})}
      title={reorderable ? 'Drag to reorder' : undefined}
      className={cn(
        'group/header relative flex h-8 shrink-0 items-center justify-between border-r border-border-default px-2 text-[12px] font-medium text-muted',
        // #413 — the cursor must cover exactly what responds, or the header
        // grows a region that looks draggable and is not (and vice versa).
        reorderable && 'cursor-grab touch-none active:cursor-grabbing',
        sticky && 'bg-app shadow-[2px_0_4px_-2px_rgba(15,23,41,0.12)]',
        /* #409/#411 — `z-40 opacity-70` is what let the dragged header paint
           over its neighbours AND over the frozen first column (whose sticky z
           is 30 + …). The content now floats in the shared portalled overlay,
           so this slot never competes for stacking order. */
        vacatedSlotClass(sortable.isDragging),
      )}
    >
      {/* The whole name is the drag handle, not just the (hover-only) grip icon —
          a 12px opacity-0 grip was too hard to grab, so reorder felt broken (MN-225). */}
      {/* #413 — the listeners moved to the cell above; this span is now just
          layout for the grip, the name and the filter marker. */}
      <span className="flex min-w-0 items-center gap-1">
        {reorderable && (
          <GripVertical className="-ml-1 h-3 w-3 shrink-0 text-faint opacity-0 group-hover/header:opacity-100" />
        )}
        <span className="truncate">{field.displayName}</span>
        {/* #224: always visible, not hover-gated — an active filter is state the
            user needs to see without hunting for it. */}
        {isFiltered && (
          <span
            className="shrink-0 text-accent"
            title={
              filteredCount === 1
                ? `Filtered by ${field.displayName}`
                : `${filteredCount} filters on ${field.displayName}`
            }
          >
            <ListFilter className="h-3 w-3" />
          </span>
        )}
      </span>
      {isFirst && onTogglePin && (
        <button
          className="rounded p-0.5 text-faint opacity-0 hover:bg-active hover:text-ink group-hover/header:opacity-100"
          title={pinned ? 'Unfreeze column' : 'Freeze column'}
          /* #413 — see the note on the menu triggers: pinning is not a drag. */
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              /* #413 — the cell is the drag handle now, so every control inside
                 it must keep its own gesture off the reorder sensor. Same guard
                 the resize handle has carried since MN-225. */
              onPointerDown={(e) => e.stopPropagation()}
              className="rounded p-0.5 opacity-0 hover:bg-active group-hover/header:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {/* #492 — Edit/Change-type/Delete are the three destructive schema
                ops a system field genuinely must not offer (read_only per
                system-fields.ts) — gated on canManage individually now, not by
                the whole menu's presence. */}
            {canManage && <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit field</DropdownMenuItem>}
            {canManage && <DropdownMenuItem onSelect={() => setDialog('change-type')}>Change type</DropdownMenuItem>}
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
            {isFiltered && (
              <DropdownMenuItem onSelect={clearFilterOnField}>
                <FilterX className="mr-2 h-3.5 w-3.5" /> Clear filter on this field
              </DropdownMenuItem>
            )}
            {canHide && (
              <DropdownMenuItem onSelect={hideField}>
                <EyeOff className="mr-2 h-3.5 w-3.5" /> Hide field
              </DropdownMenuItem>
            )}
            {canManage && (
              <DropdownMenuItem className="text-error" onSelect={() => deleteField.mutate()}>
                Delete field
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canConfigureTitle && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              /* #413 — the cell is the drag handle now, so every control inside
                 it must keep its own gesture off the reorder sensor. Same guard
                 the resize handle has carried since MN-225. */
              onPointerDown={(e) => e.stopPropagation()}
              className="rounded p-0.5 opacity-0 hover:bg-active group-hover/header:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setDialog('edit')}>Configure name…</DropdownMenuItem>
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
