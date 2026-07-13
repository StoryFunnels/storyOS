'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CellDisplay, fieldValue, isSystemDate } from '../table-view/cells';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field, RecordRow } from '../table-view/use-table-data';
import { fmtDate, MONTH_NAMES, monthMatrix } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { ViewConfig } from './use-view-state';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Calendar view (MN-051): records as chips on a month grid by date field. */
export function CalendarView({
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
  const router = useRouter();
  const dateField = database.data?.fields.find((f) => f.id === config.date_field_id);
  const today = new Date();
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });

  const grid = useMemo(() => monthMatrix(view.year, view.month), [view]);
  const windowFilter = useMemo(() => {
    if (!dateField) return undefined;
    // The compiler exposes exclusive before/after for dates — widen by a day on each side.
    const dayBefore = new Date(grid[0]!.getFullYear(), grid[0]!.getMonth(), grid[0]!.getDate() - 1);
    const dayAfter = new Date(grid[41]!.getFullYear(), grid[41]!.getMonth(), grid[41]!.getDate() + 1);
    const range = [
      { field: dateField.apiName, op: 'after', value: fmtDate(dayBefore) + 'T23:59:59' },
      { field: dateField.apiName, op: 'before', value: fmtDate(dayAfter) },
    ];
    const existing = config.filters?.and ?? (config.filters ? [config.filters] : []);
    return { and: [...existing, ...range] };
  }, [dateField, grid, config.filters]);

  const records = useRecordsInfinite(
    ws,
    db,
    windowFilter ? { filter: windowFilter, limit: 200 } : { limit: 200 },
  );
  const { updateRecord, createRecord } = useRecordMutations(ws, db);
  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const chipFields = useMemo(
    () => (database.data?.fields ?? []).filter((f) => config.card_field_ids.includes(f.id)),
    [database.data, config.card_field_ids],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, RecordRow[]>();
    if (!dateField) return map;
    for (const row of rows) {
      const raw = fieldValue(row, dateField);
      if (typeof raw !== 'string') continue;
      // Datetimes bucket by the viewer's local day (documented, matches Notion).
      const day = raw.length > 10 ? fmtDate(new Date(raw)) : raw.slice(0, 10);
      const list = map.get(day) ?? [];
      list.push(row);
      map.set(day, list);
    }
    return map;
  }, [rows, dateField]);

  const undatedCount = useMemo(() => {
    if (!dateField) return 0;
    return 0; // window query excludes undated by definition; counted via a hint link instead
  }, [dateField]);

  const lastDragEnd = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragEnd(event: DragEndEvent) {
    lastDragEnd.current = Date.now();
    if (!dateField || !event.over || readOnly || isSystemDate(dateField.type)) return;
    const day = String(event.over.id).replace('day:', '');
    const rec = String(event.active.id);
    const row = rows.find((r) => r.id === rec);
    if (!row) return;
    const raw = fieldValue(row, dateField);
    // Preserve the time component for datetime fields.
    const time = typeof raw === 'string' && raw.length > 10 ? raw.slice(10) : '';
    updateRecord.mutate({ rec, values: { [dateField.apiName]: `${day}${time}` } });
  }

  if (!dateField) {
    return (
      <p className="p-6 text-sm text-muted">
        This calendar has no valid date field. Pick one in the toolbar ("Date field").
      </p>
    );
  }

  const todayStr = fmtDate(today);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-default px-4 py-2">
        <span className="text-sm font-semibold text-ink">
          {MONTH_NAMES[view.month]} {view.year}
        </span>
        <button
          className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
          onClick={() => setView(shift(view, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
          onClick={() => setView(shift(view, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          className="rounded px-2 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
          onClick={() => setView({ year: today.getFullYear(), month: today.getMonth() })}
        >
          Today
        </button>
        <Link
          href={`/w/${ws}/d/${db}`}
          className="ml-auto text-[12px] text-faint underline-offset-2 hover:text-ink hover:underline"
        >
          Undated records → table
        </Link>
        {undatedCount > 0 && <span />}
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-y-auto">
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-b border-r border-border-default bg-app px-2 py-1 text-[11px] font-medium text-faint">
              {d}
            </div>
          ))}
          {grid.map((day) => {
            const iso = fmtDate(day);
            const inMonth = day.getMonth() === view.month;
            const chips = byDay.get(iso) ?? [];
            return (
              <DayCell
                key={iso}
                iso={iso}
                dayNumber={day.getDate()}
                inMonth={inMonth}
                isToday={iso === todayStr}
                chips={chips}
                chipFields={chipFields}
                memberNames={memberNames}
                readOnly={readOnly}
                onOpen={(id) => {
                  if (Date.now() - lastDragEnd.current < 200) return;
                  router.push(`/w/${ws}/d/${db}/r/${id}`);
                }}
                onCreate={() => {
                  if (readOnly) return;
                  createRecord.mutate(
                    isSystemDate(dateField.type) ? { name: 'Untitled' } : { name: 'Untitled', [dateField.apiName]: iso },
                    { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
                  );
                }}
              />
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function shift(view: { year: number; month: number }, delta: number) {
  const d = new Date(view.year, view.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function DayCell({
  iso,
  dayNumber,
  inMonth,
  isToday,
  chips,
  chipFields,
  memberNames,
  readOnly,
  onOpen,
  onCreate,
}: {
  iso: string;
  dayNumber: number;
  inMonth: boolean;
  isToday: boolean;
  chips: RecordRow[];
  chipFields: Field[];
  memberNames: Map<string, string>;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${iso}` });
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? chips : chips.slice(0, 3);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-24 border-b border-r border-border-default p-1',
        !inMonth && 'bg-app',
        isOver && 'bg-accent-soft',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCreate();
      }}
    >
      <span
        className={cn(
          'mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]',
          inMonth ? 'text-ink-secondary' : 'text-faint',
          isToday && 'bg-primary font-semibold text-[var(--text-on-dark)]',
        )}
      >
        {dayNumber}
      </span>
      {visible.map((row) => (
        <CalendarChip
          key={row.id}
          row={row}
          chipFields={chipFields}
          memberNames={memberNames}
          disabled={readOnly}
          onOpen={() => onOpen(row.id)}
        />
      ))}
      {chips.length > 3 && !expanded && (
        <button
          className="mt-0.5 text-[11px] text-muted hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          +{chips.length - 3} more
        </button>
      )}
    </div>
  );
}

function CalendarChip({
  row,
  chipFields,
  memberNames,
  disabled,
  onOpen,
}: {
  row: RecordRow;
  chipFields: Field[];
  memberNames: Map<string, string>;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id, disabled });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'mb-0.5 cursor-pointer rounded border border-border-default bg-card px-1.5 py-0.5 hover:border-border-strong',
        isDragging && 'opacity-40',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <p className="truncate text-[12px] font-medium text-ink">{row.title || 'Untitled'}</p>
      {chipFields.map((field) => {
        const value = row.values[field.apiName];
        if (value === undefined || value === null || value === '') return null;
        return (
          <div key={field.id} className="truncate text-[11px] text-muted">
            <CellDisplay field={field} value={value} memberNames={memberNames} />
          </div>
        );
      })}
    </div>
  );
}
