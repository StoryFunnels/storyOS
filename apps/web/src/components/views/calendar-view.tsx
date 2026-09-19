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
import { CellDisplay, fieldValue, isSystemDate, optionColor } from '../table-view/cells';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field, RecordRow } from '../table-view/use-table-data';
import { addDays, fmtDate, MONTH_NAMES, monthMatrix, weekDays } from '@/lib/dates';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';

/* #738 — hoisted so the array identity is stable across renders; Segmented
   takes a readonly list, and a literal here would be a new array every time. */
const CALENDAR_MODE_OPTIONS = [
  { value: 'month' as const, label: 'month' },
  { value: 'week' as const, label: 'week' },
  { value: 'day' as const, label: 'day' },
];
import type { FilterNode, ViewConfig } from './use-view-state';
import { sortsBodyFromConfig } from './use-view-state';
import { activeFilterNode, andFilterNodes } from './filter-config';
import { ViewQueryError } from './query-error';
import { CALENDAR_INCREMENT_OPTIONS, CalendarTimeGrid, dayRangeFilter } from './calendar-time-grid';
import { shiftDateValue } from './calendar-time-grid-layout';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Calendar view (MN-051): records as chips on a month grid by date field. */
export function CalendarView({
  ws,
  db,
  config,
  readOnly,
  onPatch,
  personalFilter,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #470 — persists the day/week/month mode choice per view (AC2). Optional
   *  only because a couple of call sites predate this ticket; every real
   *  caller (the database page) passes it. */
  onPatch?: (updates: Partial<ViewConfig>) => void;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  const dateField = database.data?.fields.find((f) => f.id === config.date_field_id);
  // #470 — an optional SECOND date field giving a day/week event real height.
  // Unset (the default, and every calendar saved before this ticket) falls
  // back to a fixed display duration — see calendar-time-grid-layout.ts.
  const endDateField = database.data?.fields.find((f) => f.id === config.calendar_end_date_field_id);
  const today = new Date();
  // #470 — mode + a single anchor date drive navigation uniformly across all
  // three modes; {year, month} for the month grid is DERIVED from it below,
  // never a second, independently-clicked piece of state.
  const mode = config.calendar_mode ?? 'month';
  const [anchorDate, setAnchorDate] = useState(today);
  const view = { year: anchorDate.getFullYear(), month: anchorDate.getMonth() };

  const grid = useMemo(() => monthMatrix(view.year, view.month), [view.year, view.month]);
  const week = useMemo(() => weekDays(anchorDate), [anchorDate]);
  const days = mode === 'day' ? [anchorDate] : mode === 'week' ? week : grid;

  const windowFilter = useMemo(() => {
    if (!dateField) return undefined;
    // The compiler exposes exclusive before/after for dates — widen by a day on each side.
    let range: unknown[];
    if (mode === 'month') {
      const dayBefore = new Date(grid[0]!.getFullYear(), grid[0]!.getMonth(), grid[0]!.getDate() - 1);
      const dayAfter = new Date(grid[41]!.getFullYear(), grid[41]!.getMonth(), grid[41]!.getDate() + 1);
      range = [
        { field: dateField.apiName, op: 'after', value: fmtDate(dayBefore) + 'T23:59:59' },
        { field: dateField.apiName, op: 'before', value: fmtDate(dayAfter) },
      ];
    } else {
      range = dayRangeFilter(mode === 'day' ? [anchorDate] : week, dateField.apiName).and;
    }
    // Skip disabled clauses (MN-253 UI) here too — this builds its own query filter
    // rather than going through queryBodyFromConfig, so it has to prune the same way.
    // The active filter (possibly an {and:[...]}/{or:[...]} group) AND the personal
    // override (#259) each nest as one item alongside the two range conditions — the
    // API's filter AST allows this, same top-level-AND-wrap queryBodyFromConfig uses.
    const active = andFilterNodes(activeFilterNode(config.filters), personalFilter);
    const existing: unknown[] = active ? [active] : [];
    return { and: [...existing, ...range] };
  }, [dateField, grid, week, anchorDate, mode, config.filters, personalFilter]);

  // MN-252: apply the same persisted sort spec here too (e.g. chips within a day
  // ordered by priority) — this view builds its own filter, so it borrows just the
  // sorts/nulls slice of the shared query-body builder rather than forking a second
  // sort-application path.
  const records = useRecordsInfinite(ws, db, {
    ...(windowFilter ? { filter: windowFilter } : {}),
    ...sortsBodyFromConfig(config),
    limit: 200,
  });
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
  /* #226 — colour the whole card, not a left accent bar. Same `color_by_field_id`
     the feed/list/timeline views already read (MN-102), resolved through the same
     shared `optionColor`, so the calendar can't drift into its own colour rule. */
  const colorField = useMemo(
    () =>
      (database.data?.fields ?? []).find(
        (f) => f.id === config.color_by_field_id && (f.type === 'select' || f.type === 'workflow'),
      ),
    [database.data, config.color_by_field_id],
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
    if (typeof raw !== 'string') return;
    // Preserve the time component for datetime fields.
    const time = raw.length > 10 ? raw.slice(10) : '';
    const values: Record<string, string> = { [dateField.apiName]: `${day}${time}` };
    // #470 — an end field can now exist regardless of mode (AC8: month drag must
    // keep working). Shift it by the same whole-day delta so start/end stay in
    // sync, mirroring CalendarTimeGrid's own onReschedule.
    if (endDateField) {
      const deltaDays = Math.round(
        (new Date(`${day}T00:00:00`).getTime() - new Date(`${raw.slice(0, 10)}T00:00:00`).getTime()) /
          (24 * 60 * 60 * 1000),
      );
      const endRaw = fieldValue(row, endDateField);
      if (typeof endRaw === 'string' && deltaDays !== 0) {
        values[endDateField.apiName] = shiftDateValue(endRaw, deltaDays, 0);
      }
    }
    updateRecord.mutate({ rec, values });
  }

  // Shared by both the month grid (desktop) and the agenda list (mobile, MN-230d)
  // so "create on an empty day" behaves identically either way.
  function handleCreate(iso: string) {
    if (readOnly || !dateField) return;
    createRecord.mutate(
      isSystemDate(dateField.type) ? { name: 'Untitled' } : { name: 'Untitled', [dateField.apiName]: iso },
      { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
    );
  }

  if (!dateField) {
    return (
      <p className="p-6 text-sm text-muted">
        This calendar has no valid date field. Pick one in the toolbar ("Date field").
      </p>
    );
  }

  const todayStr = fmtDate(today);

  // #346 — a rejected query must never render as an empty view. Placed after every
  // hook so the early return cannot change hook order.
  if (records.isError) return <ViewQueryError error={records.error} onRetry={() => void records.refetch()} />;

  // #470 — one anchor date, shifted by whatever "one step" means for the
  // current mode. Replaces the old month-only prev/next; a month step keeps
  // the existing "always land on the 1st" behaviour (AC6), unaffected by
  // anchorDate's day-of-month component the rest of the time.
  const shiftAnchor = (delta: number) => {
    setAnchorDate((d) => {
      if (mode === 'month') return new Date(d.getFullYear(), d.getMonth() + delta, 1);
      if (mode === 'week') return addDays(d, delta * 7);
      return addDays(d, delta);
    });
  };
  const headerLabel =
    mode === 'month'
      ? `${MONTH_NAMES[view.month]} ${view.year}`
      : mode === 'week'
        ? `${week[0]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${week[6]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : anchorDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-default px-4 py-2">
        <span className="text-sm font-semibold text-ink">{headerLabel}</span>
        <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" onClick={() => shiftAnchor(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" onClick={() => shiftAnchor(1)}>
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          className="rounded px-2 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
          onClick={() => setAnchorDate(today)}
        >
          Today
        </button>
        {/* #470 AC2 — persists with the VIEW (onPatch → config.calendar_mode),
            not per session, so reopening this view later shows the same mode. */}
        <Segmented
          label="Calendar mode"
          value={mode}
          onChange={(m) => onPatch?.({ calendar_mode: m })}
          options={CALENDAR_MODE_OPTIONS}
          itemClassName="capitalize"
        />
        {/* #471 AC3/AC4 — day/week-only settings; the month grid has no
            concept of a time increment or an hour window. */}
        {mode !== 'month' && (
          <>
            <select
              className="rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 py-0.5 text-[12px] text-ink-secondary"
              value={config.calendar_increment_minutes ?? 15}
              onChange={(e) => onPatch?.({ calendar_increment_minutes: Number(e.target.value) as 10 | 15 | 30 | 60 })}
              title="Drag and create snap to this increment"
            >
              {CALENDAR_INCREMENT_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <CollapsedHoursControl
              value={config.calendar_collapsed_hours}
              onChange={(value) => onPatch?.({ calendar_collapsed_hours: value })}
            />
          </>
        )}
        <Link
          href={`/w/${ws}/d/${db}`}
          className="ml-auto text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Undated records → table
        </Link>
        {undatedCount > 0 && <span />}
      </div>

      {mode === 'month' ? (
        <>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {/* MN-230d: a 7-column grid is unreadable under ~375px (≈49px cells) —
                switch to a scrollable one-column agenda below `md`, keep the
                familiar month grid at `md` and up. */}
            <div className="hidden flex-1 auto-rows-fr grid-cols-7 overflow-y-auto md:grid">
              {WEEKDAYS.map((d) => (
                <div key={d} className="border-b border-r border-border-default bg-app px-2 py-1 text-[11px] font-medium text-muted">
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
                    colorField={colorField}
                    memberNames={memberNames}
                    readOnly={readOnly}
                    onOpen={(id) => {
                      if (Date.now() - lastDragEnd.current < 200) return;
                      router.push(`/w/${ws}/d/${db}/r/${id}`);
                    }}
                    onCreate={() => handleCreate(iso)}
                  />
                );
              })}
            </div>
          </DndContext>

          <AgendaList
            grid={grid}
            month={view.month}
            byDay={byDay}
            chipFields={chipFields}
            colorField={colorField}
            memberNames={memberNames}
            readOnly={readOnly}
            todayStr={todayStr}
            onOpen={(id) => router.push(`/w/${ws}/d/${db}/r/${id}`)}
            onCreate={handleCreate}
          />
        </>
      ) : (
        <CalendarTimeGrid
          days={days}
          rows={rows}
          dateField={dateField}
          endDateField={endDateField}
          chipFields={chipFields}
          colorField={colorField}
          memberNames={memberNames}
          readOnly={readOnly}
          incrementMinutes={config.calendar_increment_minutes}
          collapsedHours={config.calendar_collapsed_hours}
          onOpen={(id) => router.push(`/w/${ws}/d/${db}/r/${id}`)}
          onCreate={handleCreate}
          onReschedule={(rec, values) => updateRecord.mutate({ rec, values })}
        />
      )}
    </div>
  );
}

/**
 * #471 AC4/AC7 — collapse the day/week grid's rendered hour axis to a chosen
 * window. A checkbox plus two hour <select>s rather than a time picker: the
 * schema only stores whole hours (calendar_collapsed_hours), and the grid
 * itself only ever draws whole-hour rows, so offering finer input would
 * promise a precision nothing downstream honours.
 */
function CollapsedHoursControl({
  value,
  onChange,
}: {
  value: { start: number; end: number } | undefined;
  onChange: (value: { start: number; end: number } | undefined) => void;
}) {
  const enabled = value !== undefined;
  const start = value?.start ?? 8;
  const end = value?.end ?? 22;
  const hourLabel = (h: number) => (h === 0 || h === 24 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
  return (
    <label className="flex items-center gap-1 text-[12px] text-ink-secondary">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked ? { start, end } : undefined)}
      />
      Collapse hours
      {enabled && (
        <>
          <select
            className="rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-[12px]"
            value={start}
            onChange={(e) => onChange({ start: Number(e.target.value), end })}
          >
            {Array.from({ length: 24 }, (_, h) => h)
              .filter((h) => h < end)
              .map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
          </select>
          <span>–</span>
          <select
            className="rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-[12px]"
            value={end}
            onChange={(e) => onChange({ start, end: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, h) => h + 1)
              .filter((h) => h > start)
              .map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
          </select>
        </>
      )}
    </label>
  );
}

/**
 * Mobile agenda/list layout (MN-230d, Phase 3 of the responsive plan): one
 * scrollable column, a row per day of the displayed month. Chips reuse the
 * same field display as the month grid; an empty day gets a quick "+ Add"
 * affordance so capture still works without the grid.
 */
function AgendaList({
  grid,
  month,
  byDay,
  chipFields,
  colorField,
  memberNames,
  readOnly,
  todayStr,
  onOpen,
  onCreate,
}: {
  grid: Date[];
  month: number;
  byDay: Map<string, RecordRow[]>;
  chipFields: Field[];
  /** #226 — select/workflow field whose option colour fills the whole card. */
  colorField: Field | undefined;
  memberNames: Map<string, string>;
  readOnly: boolean;
  todayStr: string;
  onOpen: (id: string) => void;
  onCreate: (iso: string) => void;
}) {
  const days = grid.filter((d) => d.getMonth() === month);
  return (
    <div className="flex-1 divide-y divide-border-default overflow-y-auto md:hidden">
      {days.map((day) => {
        const iso = fmtDate(day);
        const chips = byDay.get(iso) ?? [];
        const isToday = iso === todayStr;
        return (
          <div key={iso} className="flex gap-3 px-4 py-2.5">
            <div className="w-10 shrink-0 text-center">
              <div className="text-[10px] uppercase text-muted">{WEEKDAYS[(day.getDay() + 6) % 7]}</div>
              <div className={cn('text-[14px]', isToday ? 'font-semibold text-primary' : 'text-ink-secondary')}>
                {day.getDate()}
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-1 pt-0.5">
              {chips.length === 0 ? (
                !readOnly && (
                  <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => onCreate(iso)}>
                    + Add
                  </button>
                )
              ) : (
                chips.map((row) => {
                  // #226 — the mobile agenda paints from the SAME colour rule as the
                  // month grid. Colouring only the desktop grid is how two surfaces
                  // showing the same records start disagreeing (field-surfaces.md).
                  const fill = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
                  return (
                  <button
                    key={row.id}
                    type="button"
                    style={fill ? { backgroundColor: `${fill}22`, borderColor: `${fill}55` } : undefined}
                    className="block w-full rounded border border-border-default bg-card px-2 py-1 text-left hover:border-border-strong"
                    onClick={() => onOpen(row.id)}
                  >
                    <p className="truncate text-[13px] font-medium text-ink">{row.title || 'Untitled'}</p>
                    {chipFields.map((field) => {
                      const value = row.values[field.apiName];
                      if (value === undefined || value === null || value === '') return null;
                      return (
                        <div key={field.id} className="truncate text-[11px] text-muted">
                          <CellDisplay field={field} value={value} memberNames={memberNames} />
                        </div>
                      );
                    })}
                  </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayCell({
  iso,
  dayNumber,
  inMonth,
  isToday,
  chips,
  chipFields,
  colorField,
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
  /** #226 — select/workflow field whose option colour fills the whole card. */
  colorField: Field | undefined;
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
          // #706 — an out-of-month day is DE-EMPHASISED, not decorative: the cell
          // is clickable (onCreate) and a drop target, so this number is how you
          // know which date you are about to act on. At 11px, AA's 4.5:1 applies
          // in full, and faint measured 3.22:1 on --bg-app.
          //
          // THE COST IS REAL AND MEASURED, not waved away. The in/out-of-month
          // contrast step narrows from 2.69:1 (secondary vs faint) to 1.85:1
          // (secondary vs muted) in dark, 1.99:1 in light. Still a visible step,
          // but a smaller one.
          //
          // And do NOT reach for the cell's own `bg-app` as the compensating
          // signal — I did, and measured it: --bg-app against --bg-card is
          // 1.07:1 light and 1.09:1 dark, which is invisible. The month boundary
          // is carried almost entirely by this text colour, not by the
          // background, which is the opposite of what the markup suggests.
          // Strengthening that boundary is a real design question and belongs in
          // its own ticket, not smuggled into a contrast sweep.
          inMonth ? 'text-ink-secondary' : 'text-muted',
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
          colorField={colorField}
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
  colorField,
  memberNames,
  disabled,
  onOpen,
}: {
  row: RecordRow;
  chipFields: Field[];
  colorField: Field | undefined;
  memberNames: Map<string, string>;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id, disabled });
  /**
   * #226 — "Color fill the task card instead of just showing a bar on the left."
   * The fill is the option's own colour at low alpha with that colour as the
   * border, matching the soft-tint treatment #207 established for select badges.
   * A month grid of fully saturated cards reads as a wall of colour; the tint keeps
   * the coding legible and stays theme-adaptive, since the `22`/`55` alphas
   * composite over whatever the theme paints beneath (cream in light, ink in dark).
   */
  const fill = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={fill ? { backgroundColor: `${fill}22`, borderColor: `${fill}55` } : undefined}
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
