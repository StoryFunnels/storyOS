'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Link from 'next/link';
import { GripVertical, Maximize2, MoreHorizontal, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useShortcut } from '@/lib/shortcuts';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CellDisplay, CellEditor, PressButton, fieldValue } from './cells';
import {
  AddFieldDialog,
  ChangeTypeDialog,
  EditFieldDialog,
  useDeleteField,
  useFieldMutations,
} from './field-dialogs';
import { RelationEditor } from './relation-cell';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
  useRecordsInfinite,
} from './use-table-data';
import type { Field, RecordRow } from './use-table-data';
import { recordHref } from '@/lib/records';
import { cn } from '@/lib/utils';

const ROW_HEIGHT = 32;
const DEFAULT_WIDTH = 180;
const TITLE_WIDTH = 260;

// The public id renders in the row gutter (Airtable-style), not as its own column.
const HIDDEN_TYPES = new Set(['id', 'created_by']);
// checkbox toggles on click; rich_text edits on the record page; lookup is computed.
const NO_EDITOR = new Set(['checkbox', 'rich_text', 'lookup', 'button', 'formula', 'created_at', 'updated_at']);

interface Cursor {
  row: number;
  col: number;
}

export function TableView({
  ws,
  db,
  readOnly,
  schemaEditable = !readOnly,
  queryBody,
  hiddenFieldIds,
  columnWidths,
  onColumnResize,
}: {
  ws: string;
  db: string;
  readOnly: boolean;
  schemaEditable?: boolean;
  queryBody?: Record<string, unknown>;
  hiddenFieldIds?: string[];
  columnWidths?: Record<string, number>;
  onColumnResize?: (fieldId: string, width: number) => void;
}) {
  const database = useDatabase(ws, db);
  const records = useRecordsInfinite(ws, db, queryBody);
  const { updateRecord, createRecord, deleteRecord } = useRecordMutations(ws, db);

  const fields = useMemo(
    () =>
      (database.data?.fields ?? []).filter(
        (f) => !HIDDEN_TYPES.has(f.type) && !(hiddenFieldIds ?? []).includes(f.id),
      ),
    [database.data, hiddenFieldIds],
  );
  const hasUserField = fields.some((f) => f.type === 'user');
  const members = useMembers(ws, hasUserField && !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name, image: m.user.image })),
    [members.data],
  );
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.id, m.name])), [memberList]);
  const memberImages = useMemo(() => new Map(memberList.map((m) => [m.id, m.image])), [memberList]);

  const rows = useMemo(
    () => (records.data?.pages ?? []).flatMap((page) => page.data),
    [records.data],
  );

  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingField, setAddingField] = useState(false);

  // First column frozen by default; per-user, per-database preference (MN-083).
  const pinKey = `storyos:pin-first:${db}`;
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    if (typeof window !== 'undefined') setPinned(window.localStorage.getItem(pinKey) !== '0');
  }, [pinKey]);
  const togglePinned = () => {
    setPinned((p) => {
      const next = !p;
      if (typeof window !== 'undefined') window.localStorage.setItem(pinKey, next ? '1' : '0');
      return next;
    });
  };

  // Drag-to-reorder columns → writes field.position (MN-083).
  const qc = useQueryClient();
  const columnSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const reorderColumns = useMutation({
    mutationFn: async (moves: Array<{ fieldId: string; position: number }>) => {
      for (const m of moves) {
        const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
          params: { path: { ws, db, field: m.fieldId } },
          body: { position: m.position },
        });
        if (error) throw error;
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });
  function onColumnDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    // The frozen leading columns (id, title) stay put; reorder happens among the rest.
    const rest = fields.slice(frozenCount);
    const from = rest.findIndex((f) => f.id === event.active.id);
    const to = rest.findIndex((f) => f.id === event.over!.id);
    if (from < 0 || to < 0) return;
    const next = [...fields.slice(0, frozenCount), ...arrayMove(rest, from, to)];
    const moves = next
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => !f.isSystem)
      .map(({ f, i }) => ({ fieldId: f.id, position: i }));
    if (moves.length) reorderColumns.mutate(moves);
  }
  const gridRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // MN-050: multi-select + batch edit
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | null>(null);
  const toggleSelect = useCallback(
    (rowIndex: number, shift: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const allRows = (records.data?.pages ?? []).flatMap((p) => p.data);
        if (shift && anchorRef.current !== null) {
          const [lo, hi] = [Math.min(anchorRef.current, rowIndex), Math.max(anchorRef.current, rowIndex)];
          for (let i = lo; i <= hi; i++) {
            const id = allRows[i]?.id;
            if (id) next.add(id);
          }
        } else {
          const id = allRows[rowIndex]?.id;
          if (!id) return next;
          if (next.has(id)) next.delete(id);
          else next.add(id);
          anchorRef.current = rowIndex;
        }
        return next;
      });
    },
    [records.data],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Infinite scroll: fetch the next page as the tail approaches.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 30 && records.hasNextPage && !records.isFetchingNextPage) {
      void records.fetchNextPage();
    }
  }, [virtualItems, rows.length, records]);

  const widthOf = useCallback(
    (field: Field) =>
      widths[field.id] ??
      columnWidths?.[field.id] ??
      // The id column starts narrow (a compact number gutter) but is resizable (MN-087).
      (field.type === 'id' ? 56 : field.type === 'title' ? TITLE_WIDTH : DEFAULT_WIDTH),
    [widths, columnWidths],
  );

  const valueOf = (row: RecordRow, field: Field): unknown =>
    fieldValue(row, field);

  // Leading non-reorderable columns stay frozen when pinned: the public id (MN-087)
  // then the title. Everything after is draggable. If the id column is hidden, only
  // the title freezes.
  const frozenCount = useMemo(() => {
    let n = 0;
    for (const f of fields) {
      if (f.type === 'id' || f.type === 'title') n++;
      else break;
    }
    return n;
  }, [fields]);
  // Cumulative left offset (after the 56px gutter) for each frozen column.
  const frozenLeft = useCallback(
    (colIndex: number) => 56 + fields.slice(0, colIndex).reduce((sum, f) => sum + widthOf(f), 0),
    [fields, widthOf],
  );

  function commitEdit(row: RecordRow, field: Field, value: unknown) {
    setEditing(false);
    const current = valueOf(row, field) ?? null;
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    updateRecord.mutate({ rec: row.id, values: { [field.apiName]: value } });
    gridRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || rows.length === 0) return;
    const max: Cursor = { row: rows.length - 1, col: fields.length - 1 };
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setCursor((prev) => {
        const base = prev ?? { row: 0, col: 0 };
        const next = {
          row: Math.min(max.row, Math.max(0, base.row + dr)),
          col: Math.min(max.col, Math.max(0, base.col + dc)),
        };
        virtualizer.scrollToIndex(next.row);
        return next;
      });
    };
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowRight' || e.key === 'Tab') move(0, 1);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'Escape' && selected.size > 0) {
      setSelected(new Set());
    } else if (e.key.toLowerCase() === 'x' && cursor && !readOnly) {
      e.preventDefault();
      toggleSelect(cursor.row, e.shiftKey);
    } else if (e.key.toLowerCase() === 'e' && cursor) {
      const row = rows[cursor.row];
      if (row) router.push(recordHref(ws, db, row));
    } else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey) && !readOnly) {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.id)));
    } else if (e.key === 'Enter' && cursor && !readOnly) {
      e.preventDefault();
      const field = fields[cursor.col]!;
      if (field.type === 'checkbox') {
        const row = rows[cursor.row]!;
        commitEdit(row, field, !(valueOf(row, field) === true));
      } else if (!NO_EDITOR.has(field.type)) {
        setEditing(true);
      }
    }
  }

  useShortcut('n', () => {
    if (readOnly) return;
    createRecord.mutate(
      {},
      {
        onSuccess: () => {
          setCursor({ row: rows.length, col: 0 });
          setEditing(true);
          requestAnimationFrame(() => virtualizer.scrollToIndex(rows.length));
        },
      },
    );
  });

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const totalWidth =
    fields.reduce((sum, f) => sum + widthOf(f), 0) + 56 + (schemaEditable ? 110 : 0);

  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div ref={gridRef} style={{ width: totalWidth }} className="outline-none">
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-border-default bg-app">
            <div className={cn('flex w-14 shrink-0 items-center justify-center bg-app text-[11px] font-medium text-faint', pinned && 'sticky left-0 z-30')}>
              #
            </div>
            {fields.slice(0, frozenCount).map((field, i) => (
              <HeaderCell
                key={field.id}
                ws={ws}
                db={db}
                field={field}
                width={widthOf(field)}
                readOnly={!schemaEditable}
                sticky={pinned}
                stickyLeft={frozenLeft(i)}
                stickyZ={30 + (frozenCount - i)}
                isFirst={i === 0}
                pinned={pinned}
                onTogglePin={i === 0 ? togglePinned : undefined}
                onResize={(w) => {
                  setWidths((prev) => ({ ...prev, [field.id]: w }));
                  onColumnResize?.(field.id, w);
                }}
              />
            ))}
            <DndContext sensors={columnSensors} collisionDetection={closestCenter} onDragEnd={onColumnDragEnd}>
              <SortableContext items={fields.slice(frozenCount).map((f) => f.id)} strategy={horizontalListSortingStrategy}>
                {fields.slice(frozenCount).map((field) => (
                  <HeaderCell
                    key={field.id}
                    ws={ws}
                    db={db}
                    field={field}
                    width={widthOf(field)}
                    readOnly={!schemaEditable}
                    reorderable={schemaEditable}
                    onResize={(w) => {
                      setWidths((prev) => ({ ...prev, [field.id]: w }));
                      onColumnResize?.(field.id, w);
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {schemaEditable && (
              <Dialog open={addingField} onOpenChange={setAddingField}>
                <DialogTrigger asChild>
                  <button className="flex h-8 w-[110px] shrink-0 items-center gap-1.5 border-r border-border-default px-2 text-[12px] font-medium text-muted hover:bg-hover hover:text-ink">
                    <Plus className="h-3.5 w-3.5" /> New field
                  </button>
                </DialogTrigger>
                {addingField && <AddFieldDialog ws={ws} db={db} onDone={() => setAddingField(false)} />}
              </Dialog>
            )}
          </div>

          {/* Virtualized rows */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={row.id}
                  className={cn('group absolute left-0 flex w-full border-b border-border-default hover:bg-hover', selected.has(row.id) ? 'bg-accent-soft' : 'bg-card')}
                  style={{ top: item.start, height: ROW_HEIGHT }}
                >
                  <div
                    className={cn(
                      'relative flex w-14 shrink-0 items-center justify-center',
                      pinned && 'sticky left-0 z-10',
                      selected.has(row.id) ? 'bg-accent-soft' : 'bg-card group-hover:bg-hover',
                    )}
                  >
                    {/* Public id in the gutter by default (MN-087) — fades to row actions on hover. */}
                    {row.number !== null && (
                      <span
                        className={cn(
                          'text-[11px] tabular-nums text-faint',
                          selected.size > 0 ? 'opacity-0' : 'group-hover:opacity-0',
                        )}
                      >
                        {row.number}
                      </span>
                    )}
                    <div
                      className={cn(
                        'absolute inset-0 flex items-center justify-center gap-0.5',
                        selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                    >
                      {!readOnly && (
                        <input
                          type="checkbox"
                          className="h-3 w-3 cursor-pointer"
                          checked={selected.has(row.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect(item.index, (e.nativeEvent as MouseEvent).shiftKey);
                          }}
                          readOnly
                        />
                      )}
                      <Link
                        href={recordHref(ws, db, row)}
                        title="Open record"
                        className="rounded p-0.5 text-faint hover:text-ink"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </Link>
                      {!readOnly && (
                        <button
                          title="Delete record"
                          className="rounded p-0.5 text-faint hover:text-error"
                          onClick={() => deleteRecord.mutate(row.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {fields.map((field, colIndex) => {
                    const isCursor = cursor?.row === item.index && cursor?.col === colIndex;
                    const isEditing = isCursor && editing;
                    return (
                      <div
                        key={field.id}
                        style={{ width: widthOf(field), ...(pinned && colIndex < frozenCount ? { left: frozenLeft(colIndex) } : {}) }}
                        className={cn(
                          'relative flex shrink-0 items-center overflow-visible border-r border-border-default px-2',
                          isCursor && 'z-20 ring-2 ring-inset ring-[var(--accent)]',
                          pinned &&
                            colIndex < frozenCount &&
                            cn(
                              'sticky z-10',
                              colIndex === frozenCount - 1 && 'shadow-[2px_0_4px_-2px_rgba(15,23,41,0.12)]',
                              selected.has(row.id) ? 'bg-accent-soft' : 'bg-card group-hover:bg-hover',
                            ),
                        )}
                        onClick={() => {
                          setCursor({ row: item.index, col: colIndex });
                          if (readOnly) return;
                          if (field.type === 'checkbox') {
                            commitEdit(row, field, !(valueOf(row, field) === true));
                          } else if (field.type !== 'title' && field.type !== 'id' && !NO_EDITOR.has(field.type)) {
                            setEditing(true);
                          }
                        }}
                        onDoubleClick={() => {
                          // Title edits on double-click; single click selects so the
                          // hover "Open" affordance stays reachable.
                          if (!readOnly && field.type === 'title') {
                            setCursor({ row: item.index, col: colIndex });
                            setEditing(true);
                          }
                        }}
                      >
                        {isEditing && field.type === 'relation' ? (
                          <RelationEditor
                            ws={ws}
                            db={db}
                            recordId={row.id}
                            field={field}
                            current={(valueOf(row, field) as Array<{ id: string; title: string }>) ?? []}
                            onDone={() => {
                              setEditing(false);
                              gridRef.current?.focus();
                            }}
                          />
                        ) : isEditing && !NO_EDITOR.has(field.type) ? (
                          <CellEditor
                            field={field}
                            value={valueOf(row, field)}
                            members={memberList}
                            onCommit={(value) => commitEdit(row, field, value)}
                            onCancel={() => {
                              setEditing(false);
                              gridRef.current?.focus();
                            }}
                          />
                        ) : field.type === 'button' ? (
                          <PressButton
                            ws={ws}
                            db={db}
                            recordId={row.id}
                            field={field}
                            disabled={readOnly}
                            onPressed={() => updateRecord.reset()}
                          />
                        ) : (
                          <>
                            <CellDisplay field={field} value={valueOf(row, field)} memberNames={memberNames} memberImages={memberImages} />
                            {field.type === 'title' && (
                              <Link
                                href={recordHref(ws, db, row)}
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded border border-border-default bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted opacity-0 shadow-sm hover:text-ink group-hover:opacity-100"
                              >
                                <Maximize2 className="h-3 w-3" /> Open
                              </Link>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* + New row */}
          {!readOnly && (
            <button
              className="flex h-8 w-full items-center gap-2 px-3 text-[13px] text-muted hover:bg-hover"
              onClick={() => {
                createRecord.mutate(
                  {},
                  {
                    onSuccess: () => {
                      setCursor({ row: rows.length, col: 0 });
                      setEditing(true);
                      requestAnimationFrame(() => virtualizer.scrollToIndex(rows.length));
                    },
                  },
                );
              }}
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          )}
        </div>
      </div>

      {!readOnly && selected.size > 0 && (
        <BatchBar
          ws={ws}
          db={db}
          fields={fields.filter((f) => !NO_EDITOR.has(f.type) && f.type !== 'relation' && !f.isSystem)}
          members={memberList}
          selected={[...selected]}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

/** MN-050: floating selection bar — set any field once, apply to all selected. */
function BatchBar({
  ws,
  db,
  fields,
  members,
  selected,
  onClear,
}: {
  ws: string;
  db: string;
  fields: Field[];
  members: Array<{ id: string; name: string; image?: string | null }>;
  selected: string[];
  onClear: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [settingField, setSettingField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);

  async function applyValues(values: Record<string, unknown>) {
    setBusy(true);
    const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/batch', {
      params: { path: { ws, db } },
      body: { record_ids: selected, values } as never,
    });
    setBusy(false);
    setSettingField(null);
    if (error) {
      toast.error('Batch update failed');
      return;
    }
    const result = data as unknown as { updated: number; failed: Array<{ message: string }> };
    invalidate();
    if (result.failed.length > 0) {
      toast.warning(`Updated ${result.updated}, ${result.failed.length} failed (${result.failed[0]!.message})`);
    } else {
      toast.success(`Updated ${result.updated} record${result.updated === 1 ? '' : 's'}`);
    }
  }

  async function trashAll() {
    setBusy(true);
    const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-delete', {
      params: { path: { ws, db } },
      body: { record_ids: selected } as never,
    });
    setBusy(false);
    if (error) {
      toast.error('Could not move to trash');
      return;
    }
    const result = data as unknown as { deleted: number; record_ids: string[] };
    invalidate();
    onClear();
    toast.success(`${result.deleted} moved to trash`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-restore', {
            params: { path: { ws, db } },
            body: { record_ids: result.record_ids } as never,
          });
          invalidate();
        },
      },
    });
  }

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
      <div className="pointer-events-auto relative flex items-center gap-2 rounded-full border border-border-default bg-card px-4 py-2 shadow-[0_8px_24px_rgba(15,23,41,0.18)]">
        <span className="text-[13px] font-medium text-ink">{selected.length} selected</span>
        <span className="h-4 w-px bg-border-default" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded px-1.5 py-0.5 text-[13px] text-ink-secondary hover:bg-hover" disabled={busy}>
              Set field ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-64 overflow-y-auto">
            {fields.map((field) => (
              <DropdownMenuItem key={field.id} onSelect={() => setSettingField(field)}>
                {field.displayName}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button className="rounded px-1.5 py-0.5 text-[13px] text-error hover:bg-hover" onClick={trashAll} disabled={busy}>
          Move to trash
        </button>
        <button className="rounded px-1.5 py-0.5 text-[13px] text-muted hover:bg-hover" onClick={onClear}>
          Clear
        </button>

        {settingField && (
          <div className="absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_8px_24px_rgba(15,23,41,0.15)]">
            <p className="mb-1.5 text-[12px] font-medium text-muted">
              Set “{settingField.displayName}” on {selected.length} records
            </p>
            <div className="relative min-h-8">
              <CellEditor
                field={settingField}
                value={null}
                members={members}
                onCommit={(value) => void applyValues({ [settingField.apiName]: value })}
                onCancel={() => setSettingField(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderCell({
  ws,
  db,
  field,
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
}: {
  ws: string;
  db: string;
  field: Field;
  width: number;
  readOnly: boolean;
  onResize: (width: number) => void;
  reorderable?: boolean;
  sticky?: boolean;
  stickyLeft?: number;
  stickyZ?: number;
  isFirst?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const canManage = !readOnly && field.type !== 'title' && !field.isSystem;
  const sortable = useSortable({ id: field.id, disabled: !reorderable });

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
      <span className="flex min-w-0 items-center gap-1">
        {reorderable && (
          <button
            className="-ml-1 cursor-grab touch-none text-faint opacity-0 hover:text-muted group-hover/header:opacity-100"
            {...sortable.attributes}
            {...sortable.listeners}
            title="Drag to reorder"
          >
            <GripVertical className="h-3 w-3" />
          </button>
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
          startRef.current = { x: e.clientX, width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
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
