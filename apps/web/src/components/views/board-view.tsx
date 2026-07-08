'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CellDisplay, OPTION_COLORS } from '../table-view/cells';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
  useRecordsInfinite,
} from '../table-view/use-table-data';
import type { Field, RecordRow } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

const NO_VALUE = '__none__';

export function BoardView({
  ws,
  db,
  config,
  readOnly,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
}) {
  const database = useDatabase(ws, db);
  const qc = useQueryClient();
  const groupField = database.data?.fields.find((f) => f.id === config.group_by_field_id);
  const hasSorts = config.sorts.length > 0;

  const queryBody = useMemo(() => queryBodyFromConfig(config), [config]);
  const records = useRecordsInfinite(ws, db, queryBody);
  const { createRecord } = useRecordMutations(ws, db);

  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );

  const rows = useMemo(
    () => (records.data?.pages ?? []).flatMap((p) => p.data),
    [records.data],
  );

  const cardFields = useMemo(
    () =>
      (database.data?.fields ?? []).filter(
        (f) => config.card_field_ids.includes(f.id) && f.id !== config.group_by_field_id,
      ),
    [database.data, config],
  );

  const columns = useMemo(() => {
    if (!groupField) return [];
    const buckets = new Map<string, RecordRow[]>();
    for (const option of groupField.options ?? []) buckets.set(option.id, []);
    buckets.set(NO_VALUE, []);
    for (const row of rows) {
      const value = (row.values[groupField.apiName] as string | undefined) ?? NO_VALUE;
      (buckets.get(value) ?? buckets.get(NO_VALUE)!).push(row);
    }
    return [
      ...(groupField.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        color: OPTION_COLORS[option.color] ?? OPTION_COLORS.gray!,
        rows: buckets.get(option.id)!,
      })),
      { id: NO_VALUE, label: 'No value', color: OPTION_COLORS.gray!, rows: buckets.get(NO_VALUE)! },
    ];
  }, [groupField, rows]);

  const router = useRouter();
  const [dragging, setDragging] = useState<RecordRow | null>(null);
  // A click that lands right after a drag is the drag's pointer-up, not intent to open.
  const lastDragEnd = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function openRecord(row: RecordRow) {
    if (Date.now() - lastDragEnd.current < 200) return;
    router.push(`/w/${ws}/d/${db}/r/${row.id}`);
  }

  const move = useMutation({
    mutationFn: async (input: {
      rec: string;
      after_record_id?: string;
      before_record_id?: string;
      values?: Record<string, unknown>;
    }) => {
      const { rec, ...body } = input;
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/move',
        { params: { path: { ws, db, rec } }, body: body as never },
      );
      if (error) throw error;
    },
    onError: () => toast.error('Could not move the card'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['records', ws, db] }),
  });

  function onDragStart(event: DragStartEvent) {
    setDragging(rows.find((r) => r.id === event.active.id) ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    lastDragEnd.current = Date.now();
    if (!groupField || !event.over) return;
    const overId = String(event.over.id);
    const recId = String(event.active.id);
    const record = rows.find((r) => r.id === recId);
    if (!record) return;

    // Drop target: either a column (col:<optionId>) or a card (position anchor).
    let targetColumn: string;
    let anchor: { before_record_id?: string; after_record_id?: string } = {};
    if (overId.startsWith('col:')) {
      targetColumn = overId.slice(4);
      const column = columns.find((c) => c.id === targetColumn);
      const lastCard = column?.rows.filter((r) => r.id !== recId).at(-1);
      if (lastCard && !hasSorts) anchor = { after_record_id: lastCard.id };
    } else {
      const overRecord = rows.find((r) => r.id === overId);
      if (!overRecord) return;
      targetColumn = (overRecord.values[groupField.apiName] as string | undefined) ?? NO_VALUE;
      if (!hasSorts && overId !== recId) anchor = { before_record_id: overId };
    }

    const currentColumn = (record.values[groupField.apiName] as string | undefined) ?? NO_VALUE;
    const changesColumn = targetColumn !== currentColumn;
    if (!changesColumn && Object.keys(anchor).length === 0) return;
    if (readOnly) return;

    move.mutate({
      rec: recId,
      ...anchor,
      ...(changesColumn
        ? { values: { [groupField.apiName]: targetColumn === NO_VALUE ? null : targetColumn } }
        : {}),
    });
  }

  if (!groupField) {
    return (
      <p className="p-6 text-sm text-muted">
        This board has no valid group-by field. Edit the view and pick a single-select field.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto p-4">
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            cardFields={cardFields}
            memberNames={memberNames}
            readOnly={readOnly}
            onOpen={openRecord}
            onAdd={() =>
              createRecord.mutate({
                name: 'Untitled',
                ...(column.id !== NO_VALUE ? { [groupField.apiName]: column.id } : {}),
              })
            }
          />
        ))}
      </div>
      <DragOverlay>
        {dragging && (
          <Card row={dragging} cardFields={cardFields} memberNames={memberNames} overlay />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  column,
  cardFields,
  memberNames,
  readOnly,
  onOpen,
  onAdd,
}: {
  column: { id: string; label: string; color: string; rows: RecordRow[] };
  cardFields: Field[];
  memberNames: Map<string, string>;
  readOnly: boolean;
  onOpen: (row: RecordRow) => void;
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-[var(--radius-card)] border border-border-default bg-sidebar',
        isOver && 'ring-2 ring-[var(--accent)]',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.color }} />
          {column.label}
          <span className="text-faint">{column.rows.length}</span>
        </span>
        {!readOnly && (
          <button onClick={onAdd} className="rounded p-0.5 text-muted hover:bg-active" title="Add card">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex min-h-10 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {column.rows.map((row) => (
          <DraggableCard
            key={row.id}
            row={row}
            cardFields={cardFields}
            memberNames={memberNames}
            disabled={readOnly}
            onOpen={() => onOpen(row)}
          />
        ))}
      </div>
    </div>
  );
}

function DraggableCard({
  row,
  cardFields,
  memberNames,
  disabled,
  onOpen,
}: {
  row: RecordRow;
  cardFields: Field[];
  memberNames: Map<string, string>;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(isDragging && 'opacity-40')}
      onClick={onOpen}
    >
      <Card row={row} cardFields={cardFields} memberNames={memberNames} />
    </div>
  );
}

function Card({
  row,
  cardFields,
  memberNames,
  overlay = false,
}: {
  row: RecordRow;
  cardFields: Field[];
  memberNames: Map<string, string>;
  overlay?: boolean;
}) {
  return (
    <div
      className={cn(
        'cursor-pointer rounded-[var(--radius-card)] border border-border-default bg-card p-2.5 hover:border-border-strong',
        overlay && 'shadow-[0_4px_12px_rgba(15,23,41,0.15)]',
      )}
    >
      <p className="text-[13px] font-medium text-ink">{row.title || 'Untitled'}</p>
      {cardFields.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {cardFields.map((field) => {
            const value = field.type === 'title' ? row.title : row.values[field.apiName];
            if (value === undefined || value === null || value === '') return null;
            return (
              <div key={field.id} className="flex items-center text-[12px] text-muted">
                <CellDisplay field={field} value={value} memberNames={memberNames} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
