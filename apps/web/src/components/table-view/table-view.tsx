'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Link from 'next/link';
import { Maximize2, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CellDisplay, CellEditor } from './cells';
import {
  AddFieldDialog,
  ChangeTypeDialog,
  EditFieldDialog,
  useDeleteField,
} from './field-dialogs';
import { RelationEditor } from './relation-cell';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
  useRecordsInfinite,
} from './use-table-data';
import type { Field, RecordRow } from './use-table-data';
import { cn } from '@/lib/utils';

const ROW_HEIGHT = 32;
const DEFAULT_WIDTH = 180;
const TITLE_WIDTH = 260;

const HIDDEN_TYPES = new Set(['created_at', 'updated_at', 'created_by']);
const NO_EDITOR = new Set(['checkbox']);

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
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [members.data],
  );
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.id, m.name])), [memberList]);

  const rows = useMemo(
    () => (records.data?.pages ?? []).flatMap((page) => page.data),
    [records.data],
  );

  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingField, setAddingField] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

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
      (field.type === 'title' ? TITLE_WIDTH : DEFAULT_WIDTH),
    [widths, columnWidths],
  );

  const valueOf = (row: RecordRow, field: Field): unknown =>
    field.type === 'title' ? row.title : row.values[field.apiName];

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
    else if (e.key === 'Enter' && cursor && !readOnly) {
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

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const totalWidth = fields.reduce((sum, f) => sum + widthOf(f), 0) + 40;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div ref={gridRef} style={{ width: totalWidth }} className="outline-none">
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-border-default bg-app">
            <div className="w-10 shrink-0" />
            {fields.map((field) => (
              <HeaderCell
                key={field.id}
                ws={ws}
                db={db}
                field={field}
                width={widthOf(field)}
                readOnly={!schemaEditable}
                onResize={(w) => {
                  setWidths((prev) => ({ ...prev, [field.id]: w }));
                  onColumnResize?.(field.id, w);
                }}
              />
            ))}
            {schemaEditable && (
              <Dialog open={addingField} onOpenChange={setAddingField}>
                <DialogTrigger asChild>
                  <button
                    title="Add field"
                    className="flex h-8 w-9 items-center justify-center text-muted hover:bg-hover hover:text-ink"
                  >
                    <Plus className="h-3.5 w-3.5" />
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
                  className="group absolute left-0 flex w-full border-b border-border-default bg-card hover:bg-hover"
                  style={{ top: item.start, height: ROW_HEIGHT }}
                >
                  <div className="flex w-10 shrink-0 items-center justify-center gap-0.5">
                    <Link
                      href={`/w/${ws}/d/${db}/r/${row.id}`}
                      title="Open record"
                      className="rounded p-0.5 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </Link>
                    {!readOnly && (
                      <button
                        title="Delete record"
                        className="rounded p-0.5 text-faint opacity-0 hover:text-error group-hover:opacity-100"
                        onClick={() => deleteRecord.mutate(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {fields.map((field, colIndex) => {
                    const isCursor = cursor?.row === item.index && cursor?.col === colIndex;
                    const isEditing = isCursor && editing;
                    return (
                      <div
                        key={field.id}
                        style={{ width: widthOf(field) }}
                        className={cn(
                          'relative flex shrink-0 items-center overflow-visible border-r border-border-default px-2',
                          isCursor && 'ring-2 ring-inset ring-[var(--accent)]',
                        )}
                        onClick={() => {
                          setCursor({ row: item.index, col: colIndex });
                          if (readOnly) return;
                          if (field.type === 'checkbox') {
                            commitEdit(row, field, !(valueOf(row, field) === true));
                          } else if (field.type !== 'title') {
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
                        ) : (
                          <>
                            <CellDisplay field={field} value={valueOf(row, field)} memberNames={memberNames} />
                            {field.type === 'title' && (
                              <Link
                                href={`/w/${ws}/d/${db}/r/${row.id}`}
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
}: {
  ws: string;
  db: string;
  field: Field;
  width: number;
  readOnly: boolean;
  onResize: (width: number) => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const canManage = !readOnly && field.type !== 'title' && !field.isSystem;

  return (
    <div
      style={{ width }}
      className="group/header relative flex h-8 shrink-0 items-center justify-between border-r border-border-default px-2 text-[12px] font-medium text-muted"
    >
      <span className="truncate">{field.displayName}</span>
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
          <EditFieldDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />
        )}
        {dialog === 'change-type' && (
          <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />
        )}
      </Dialog>
      <div
        className="absolute -right-0.5 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent"
        onPointerDown={(e) => {
          startRef.current = { x: e.clientX, width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!startRef.current) return;
          onResize(Math.max(80, startRef.current.width + (e.clientX - startRef.current.x)));
        }}
        onPointerUp={() => {
          startRef.current = null;
        }}
      />
    </div>
  );
}
