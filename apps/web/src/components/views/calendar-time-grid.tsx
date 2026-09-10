'use client';

import { useMemo, useRef } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { CellDisplay, fieldValue, isSystemDate, optionColor } from '../table-view/cells';
import type { Field, RecordRow } from '../table-view/use-table-data';
import { addDays, fmtDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import {
  DEFAULT_DURATION_MINUTES,
  MIN_EVENT_MINUTES,
  layoutDayEvents,
  parseDateValue,
  shiftDateValue,
} from './calendar-time-grid-layout';
import type { TimedEvent } from './calendar-time-grid-layout';

/** #470 — px per hour on the scrollable axis. 24 * 48 = 1152px tall, a size
 *  that reads clearly without needing an unreasonably tall page. */
const HOUR_HEIGHT = 48;
/** Drag snaps to a quarter-hour — fine enough to feel precise, coarse enough
 *  that a small pointer jitter doesn't miss the slot you meant. */
const SNAP_MINUTES = 15;

interface PositionedEvent {
  row: RecordRow;
  startMinutes: number;
  endMinutes: number;
}

/**
 * #470 — the day/week hour-grid calendar mode, alongside the existing month
 * grid (calendar-view.tsx, unchanged). One or seven day columns over a
 * scrolling 24-hour axis, an all-day row above it for records with no time
 * component (AC5), overlapping same-day events laid out side-by-side
 * (AC4, calendar-time-grid-layout.ts), and drag-to-reschedule that writes
 * both date AND time (AC2/AC8) — day comes from which column you drop on,
 * time from how far you dragged vertically within the gesture.
 */
export function CalendarTimeGrid({
  days,
  rows,
  dateField,
  endDateField,
  chipFields,
  colorField,
  memberNames,
  readOnly,
  onOpen,
  onCreate,
  onReschedule,
}: {
  /** 1 day (day mode) or 7 days (week mode), in display order. */
  days: Date[];
  rows: RecordRow[];
  dateField: Field;
  /** #470 — optional second FIELD giving an event its real end time. Unset =
   *  every event gets DEFAULT_DURATION_MINUTES for display only. */
  endDateField?: Field;
  chipFields: Field[];
  colorField: Field | undefined;
  memberNames: Map<string, string>;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onCreate: (iso: string) => void;
  onReschedule: (rec: string, values: Record<string, unknown>) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastDragEnd = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const dayKeys = useMemo(() => days.map((d) => fmtDate(d)), [days]);

  // #470 AC5 — split into all-day (no time component) vs timed, per day.
  const { allDayByDay, timedByDay } = useMemo(() => {
    const allDay = new Map<string, RecordRow[]>();
    const timed = new Map<string, PositionedEvent[]>();
    for (const row of rows) {
      const raw = fieldValue(row, dateField);
      if (typeof raw !== 'string') continue;
      const { dayKey, minutes } = parseDateValue(raw);
      if (!dayKeys.includes(dayKey)) continue;
      if (minutes === null) {
        const list = allDay.get(dayKey) ?? [];
        list.push(row);
        allDay.set(dayKey, list);
        continue;
      }
      const endRaw = endDateField ? fieldValue(row, endDateField) : undefined;
      const endParsed = typeof endRaw === 'string' ? parseDateValue(endRaw) : null;
      // An end value on a DIFFERENT day than the start is clipped to this
      // day's midnight — a simple, correct-enough multi-day treatment (the
      // ticket only asks same-day overlap to be handled well, AC4).
      const endMinutes =
        endParsed && endParsed.dayKey === dayKey && endParsed.minutes !== null && endParsed.minutes > minutes
          ? endParsed.minutes
          : endParsed && endParsed.dayKey > dayKey
            ? 24 * 60
            : minutes + DEFAULT_DURATION_MINUTES;
      const list = timed.get(dayKey) ?? [];
      list.push({ row, startMinutes: minutes, endMinutes: Math.max(endMinutes, minutes + MIN_EVENT_MINUTES) });
      timed.set(dayKey, list);
    }
    return { allDayByDay: allDay, timedByDay: timed };
  }, [rows, dateField, endDateField, dayKeys]);

  function onDragEnd(event: DragEndEvent) {
    lastDragEnd.current = Date.now();
    if (readOnly || !event.over) return;
    const overId = String(event.over.id);
    if (!overId.startsWith('col:')) return;
    const targetIso = overId.slice(4);
    const rec = String(event.active.id);
    const row = rows.find((r) => r.id === rec);
    if (!row || isSystemDate(dateField.type)) return;
    const raw = fieldValue(row, dateField);
    if (typeof raw !== 'string') return;
    const { dayKey: originIso, minutes } = parseDateValue(raw);
    const deltaDays = Math.round(
      (new Date(targetIso).getTime() - new Date(originIso).getTime()) / (24 * 60 * 60 * 1000),
    );
    // Vertical delta only moves the time when the event actually has one —
    // an all-day chip dragged in its own row never acquires a time (AC5's
    // promise the other direction: all-day stays all-day when moved).
    const deltaMinutes =
      minutes === null ? 0 : Math.round(event.delta.y / (HOUR_HEIGHT / 60) / SNAP_MINUTES) * SNAP_MINUTES;
    if (deltaDays === 0 && deltaMinutes === 0) return;
    const values: Record<string, unknown> = { [dateField.apiName]: shiftDateValue(raw, deltaDays, deltaMinutes) };
    if (endDateField) {
      const endRaw = fieldValue(row, endDateField);
      if (typeof endRaw === 'string') values[endDateField.apiName] = shiftDateValue(endRaw, deltaDays, deltaMinutes);
    }
    onReschedule(rec, values);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Day headers */}
        <div className="flex border-b border-border-default">
          <div className="w-12 shrink-0" />
          {days.map((d, i) => {
            const iso = dayKeys[i]!;
            const isToday = iso === fmtDate(new Date());
            return (
              <div key={iso} className="flex-1 border-l border-border-default px-2 py-1.5 text-center">
                <div className="text-[10px] uppercase text-faint">
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                <div
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full text-[13px]',
                    isToday ? 'bg-primary font-semibold text-[var(--text-on-dark)]' : 'text-ink-secondary',
                  )}
                >
                  {d.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* All-day row (AC5) */}
        <div className="flex border-b border-border-default">
          <div className="w-12 shrink-0 py-1 text-right text-[10px] text-faint">All day</div>
          {days.map((_, i) => {
            const iso = dayKeys[i]!;
            const chips = allDayByDay.get(iso) ?? [];
            return (
              <AllDayCell
                key={iso}
                iso={iso}
                rows={chips}
                colorField={colorField}
                readOnly={readOnly}
                onOpen={(id) => {
                  if (Date.now() - lastDragEnd.current < 200) return;
                  onOpen(id);
                }}
              />
            );
          })}
        </div>

        {/* Hour grid */}
        <div ref={scrollRef} className="flex flex-1 overflow-y-auto">
          <div className="w-12 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ height: HOUR_HEIGHT }} className="border-b border-border-default pr-1 text-right text-[10px] text-faint">
                {h === 0 ? '' : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`}
              </div>
            ))}
          </div>
          {days.map((_, i) => {
            const iso = dayKeys[i]!;
            const events = timedByDay.get(iso) ?? [];
            const layout = layoutDayEvents(events.map((e): TimedEvent => ({ id: e.row.id, startMinutes: e.startMinutes, endMinutes: e.endMinutes })));
            return (
              <DayColumn
                key={iso}
                iso={iso}
                events={events}
                layout={layout}
                chipFields={chipFields}
                colorField={colorField}
                memberNames={memberNames}
                readOnly={readOnly}
                onOpen={(id) => {
                  if (Date.now() - lastDragEnd.current < 200) return;
                  onOpen(id);
                }}
                onCreate={(minutes) => {
                  const pad = (n: number) => String(n).padStart(2, '0');
                  onCreate(`${iso}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`);
                }}
              />
            );
          })}
        </div>
      </div>
    </DndContext>
  );
}

function AllDayCell({
  iso,
  rows,
  colorField,
  readOnly,
  onOpen,
}: {
  iso: string;
  rows: RecordRow[];
  colorField: Field | undefined;
  readOnly: boolean;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${iso}` });
  return (
    <div ref={setNodeRef} className={cn('min-h-6 flex-1 flex-wrap gap-0.5 border-l border-border-default p-0.5', isOver && 'bg-accent-soft')}>
      {rows.map((row) => (
        <EventChip key={row.id} row={row} colorField={colorField} disabled={readOnly} onOpen={() => onOpen(row.id)} compact />
      ))}
    </div>
  );
}

function DayColumn({
  iso,
  events,
  layout,
  chipFields,
  colorField,
  memberNames,
  readOnly,
  onOpen,
  onCreate,
}: {
  iso: string;
  events: PositionedEvent[];
  layout: Map<string, { col: number; cols: number }>;
  chipFields: Field[];
  colorField: Field | undefined;
  memberNames: Map<string, string>;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onCreate: (minutes: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${iso}` });
  return (
    <div
      ref={setNodeRef}
      className={cn('relative flex-1 border-l border-border-default', isOver && 'bg-accent-soft')}
      style={{ height: 24 * HOUR_HEIGHT }}
      onClick={(e) => {
        if (readOnly || e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const minutes = Math.round(((e.clientY - rect.top) / HOUR_HEIGHT) * 60);
        onCreate(Math.max(0, Math.min(24 * 60 - MIN_EVENT_MINUTES, minutes)));
      }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }} className="pointer-events-none absolute inset-x-0 border-b border-border-default" />
      ))}
      {events.map(({ row, startMinutes, endMinutes }) => {
        const pos = layout.get(row.id) ?? { col: 0, cols: 1 };
        const top = (startMinutes / 60) * HOUR_HEIGHT;
        const height = ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT;
        const widthPct = 100 / pos.cols;
        return (
          <div
            key={row.id}
            className="absolute px-px"
            style={{ top, height, left: `${pos.col * widthPct}%`, width: `${widthPct}%` }}
          >
            <EventChip
              row={row}
              colorField={colorField}
              chipFields={chipFields}
              memberNames={memberNames}
              disabled={readOnly}
              onOpen={() => onOpen(row.id)}
              fill
            />
          </div>
        );
      })}
    </div>
  );
}

function EventChip({
  row,
  colorField,
  chipFields,
  memberNames,
  disabled,
  onOpen,
  compact,
  fill,
}: {
  row: RecordRow;
  colorField: Field | undefined;
  chipFields?: Field[];
  memberNames?: Map<string, string>;
  disabled: boolean;
  onOpen: () => void;
  /** All-day row's small unpositioned chip. */
  compact?: boolean;
  /** Timed event's absolutely-positioned block — fills its slot's height. */
  fill?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id, disabled });
  // #226/#470 — the SAME shared colour source the month grid uses
  // (calendar-view.tsx's own comment on this exact point): a day/week mode
  // painting its events a different way from the month grid is precisely the
  // kind of drift field-surfaces.md exists to stop.
  const colorTint = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={colorTint ? { backgroundColor: `${colorTint}22`, borderColor: `${colorTint}55` } : undefined}
      className={cn(
        'cursor-pointer overflow-hidden rounded border border-border-default bg-card px-1 py-0.5 text-left hover:border-border-strong',
        compact && 'mb-0.5 inline-block max-w-full align-top text-[11px]',
        fill && 'h-full w-full',
        isDragging && 'opacity-40',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <p className="truncate text-[11px] font-medium text-ink">{row.title || 'Untitled'}</p>
      {!compact &&
        chipFields?.map((field) => {
          const value = row.values[field.apiName];
          if (value === undefined || value === null || value === '') return null;
          return (
            <div key={field.id} className="truncate text-[10px] text-muted">
              <CellDisplay field={field} value={value} memberNames={memberNames ?? new Map()} />
            </div>
          );
        })}
    </div>
  );
}

/** Widened day range for a query window: the visible days, padded a day each
 *  side (matches the month grid's own before/after widening). */
export function dayRangeFilter(days: Date[], dateFieldApiName: string): { and: unknown[] } {
  const before = addDays(days[0]!, -1);
  const after = addDays(days[days.length - 1]!, 1);
  return {
    and: [
      { field: dateFieldApiName, op: 'after', value: `${fmtDate(before)}T23:59:59` },
      { field: dateFieldApiName, op: 'before', value: fmtDate(after) },
    ],
  };
}
