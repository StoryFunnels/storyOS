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
import { recordHref } from '@/lib/records';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { CellDisplay, OPTION_COLORS, fieldValue } from '../table-view/cells';
import type { LinkChip } from '../table-view/relation-cell';
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
  const memberImages = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.image])),
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
    router.push(recordHref(ws, db, row));
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
    // Optimistically move the card in the cache so it stays where it was dropped —
    // otherwise it snaps back to the old column until the refetch lands, then jumps (MN-19).
    onMutate: async (input) => {
      if (!input.values || !groupField) return {};
      await qc.cancelQueries({ queryKey: ['records', ws, db] });
      const snapshot = qc.getQueriesData<{ pages: Array<{ data: RecordRow[] }> }>({ queryKey: ['records', ws, db] });
      const newVal = (input.values[groupField.apiName] as string | null) ?? null;
      qc.setQueriesData<{ pages: Array<{ data: RecordRow[] }> }>({ queryKey: ['records', ws, db] }, (old) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            data: page.data.map((r) =>
              r.id === input.rec ? { ...r, values: { ...r.values, [groupField.apiName]: newVal } } : r,
            ),
          })),
        };
      });
      return { snapshot };
    },
    onError: (_err, _input, ctx) => {
      toast.error('Could not move the card');
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
    },
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
            size={config.card_size ?? 'medium'}
            memberNames={memberNames} memberImages={memberImages}
            readOnly={readOnly}
            onOpen={openRecord}
            onAdd={() =>
              createRecord.mutate(
                {
                  name: 'Untitled',
                  ...(column.id !== NO_VALUE ? { [groupField.apiName]: column.id } : {}),
                },
                {
                  // Land on the new record so it can be named right away.
                  onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`),
                },
              )
            }
          />
        ))}
      </div>
      <DragOverlay>
        {dragging && (
          <Card row={dragging} cardFields={cardFields} size={config.card_size ?? 'medium'} memberNames={memberNames} memberImages={memberImages} overlay />
        )}
      </DragOverlay>
    </DndContext>
  );
}

export type CardSize = 'small' | 'medium' | 'large';

function BoardColumn({
  column,
  cardFields,
  size,
  memberNames,
  memberImages,
  readOnly,
  onOpen,
  onAdd,
}: {
  column: { id: string; label: string; color: string; rows: RecordRow[] };
  cardFields: Field[];
  size: CardSize;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  readOnly: boolean;
  onOpen: (row: RecordRow) => void;
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-[var(--radius-card)] border border-border-default bg-sidebar',
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
            size={size}
            memberNames={memberNames} memberImages={memberImages}
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
  size,
  memberNames,
  memberImages,
  disabled,
  onOpen,
}: {
  row: RecordRow;
  cardFields: Field[];
  size: CardSize;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
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
      <Card row={row} cardFields={cardFields} size={size} memberNames={memberNames} memberImages={memberImages} />
    </div>
  );
}

const SIZE_STYLES: Record<CardSize, { pad: string; title: string; clamp: string; gap: string }> = {
  small: { pad: 'p-2', title: 'text-[12px]', clamp: 'line-clamp-1', gap: 'gap-1' },
  medium: { pad: 'p-2.5', title: 'text-[13px]', clamp: 'line-clamp-2', gap: 'gap-1.5' },
  large: { pad: 'p-3', title: 'text-[13px]', clamp: 'line-clamp-3', gap: 'gap-2' },
};

/** The warm palette (option colors), used to give each card field its own stable hue. */
const TRIANGLE_PALETTE = ['gold', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'brown'] as const;
function fieldColor(fieldId: string): string {
  let hash = 0;
  for (let i = 0; i < fieldId.length; i++) hash = (hash * 31 + fieldId.charCodeAt(i)) >>> 0;
  return OPTION_COLORS[TRIANGLE_PALETTE[hash % TRIANGLE_PALETTE.length]!]!;
}

/** The signature colored triangle marker (▸) before a value chip. */
function Triangle({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: 0,
        height: 0,
        borderTop: '3.5px solid transparent',
        borderBottom: '3.5px solid transparent',
        borderLeft: `6px solid ${color}`,
      }}
    />
  );
}

export function Card({
  row,
  cardFields,
  size,
  memberNames,
  memberImages,
  overlay = false,
}: {
  row: RecordRow;
  cardFields: Field[];
  size: CardSize;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  overlay?: boolean;
}) {
  const s = SIZE_STYLES[size];
  const chips = cardFields
    .map((field) => ({ field, value: fieldValue(row, field) }))
    .filter(({ value }) => !(value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)));

  return (
    <div
      className={cn(
        'cursor-pointer rounded-[var(--radius-card)] border border-border-default bg-card hover:border-border-strong',
        s.pad,
        overlay && 'shadow-[0_4px_12px_rgba(15,23,41,0.15)]',
      )}
    >
      <p className={cn('font-medium text-ink', s.title, s.clamp)}>{row.title || 'Untitled'}</p>
      {chips.length > 0 && (
        <div className={cn('mt-2 flex flex-wrap items-center', s.gap)}>
          {chips.map(({ field, value }) => (
            <CardFieldChip
              key={field.id}
              field={field}
              value={value}
              memberNames={memberNames}
              memberImages={memberImages}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One field value on a card: self-colored types render their own chip; everything
 * else gets a muted pill with the field's stable colored triangle (MN-089). */
export function CardFieldChip({
  field,
  value,
  memberNames,
  memberImages,
}: {
  field: Field;
  value: unknown;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
}) {
  if (field.type === 'select' || field.type === 'multi_select') {
    return <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />;
  }
  if (field.type === 'user') {
    const ids = Array.isArray(value) ? (value as string[]) : [String(value)];
    return (
      <span className="inline-flex items-center gap-1">
        {ids.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full bg-hover px-1.5 py-0.5 text-[11px] text-ink-secondary"
          >
            <Avatar userId={id} name={memberNames.get(id) ?? '?'} image={memberImages?.get(id)} size={16} />
            <span className="max-w-24 truncate">{memberNames.get(id) ?? '—'}</span>
          </span>
        ))}
      </span>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-hover px-1.5 py-0.5 text-[11px] text-ink-secondary">
        <input type="checkbox" checked={value === true} readOnly className="pointer-events-none h-3 w-3" />
        {field.displayName}
      </span>
    );
  }

  const color = fieldColor(field.id);
  const pill = 'inline-flex max-w-full items-center gap-1 rounded-full bg-hover px-1.5 py-0.5 text-[11px] text-ink-secondary';
  if (field.type === 'relation') {
    const links = (value as LinkChip[]) ?? [];
    return (
      <>
        {links.map((chip) => (
          <span key={chip.id} className={pill}>
            <Triangle color={color} />
            <span className="max-w-32 truncate">{chip.title || 'Untitled'}</span>
          </span>
        ))}
      </>
    );
  }
  return (
    <span className={pill}>
      <Triangle color={color} />
      <span className="max-w-40 truncate">
        <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
      </span>
    </span>
  );
}
