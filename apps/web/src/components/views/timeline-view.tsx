'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange } from 'lucide-react';
import { cn } from '@/lib/utils';
import { recordHref } from '@/lib/records';
import { CellDisplay, fieldValue, isDateField, optionColor } from '../table-view/cells';
import { useDatabase, useMembers, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field, RecordRow } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

const DAY = 86_400_000;
type Zoom = 'day' | 'week' | 'month' | 'quarter';

/** px-per-day + padding (days) per zoom level. */
const ZOOM: Record<Zoom, { px: number; label: string; pad: number }> = {
  day: { px: 30, label: 'Day', pad: 4 },
  week: { px: 13, label: 'Week', pad: 10 },
  month: { px: 4, label: 'Month', pad: 40 },
  quarter: { px: 1.8, label: 'Quarter', pad: 120 },
};

const ROW_H = 40;
const HEADER_H = 46; // two-tier axis header
const MIN_COL = 72;
const MAX_COL = 640;

function defaultColW(field: Field): number {
  if (field.type === 'title') return 240;
  if (field.type === 'select' || field.type === 'multi_select' || field.type === 'relation') return 168;
  return 150;
}

/** Parse a date/datetime cell to an integer UTC day-number, or null. */
function toDay(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / DAY);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const utcDay = (y: number, m: number, d = 1) => Math.floor(Date.UTC(y, m, d) / DAY);

interface Seg {
  left: number;
  width: number;
  label: string;
  key: string;
}

/** Axis header segment builders — each returns absolutely-positioned bands. */
function monthSegs(min: number, max: number, px: number, withYear: boolean): Seg[] {
  const out: Seg[] = [];
  const d = new Date(min * DAY);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (utcDay(y, m) <= max) {
    const first = utcDay(y, m);
    const next = utcDay(y, m + 1);
    const s = Math.max(first, min);
    const e = Math.min(next - 1, max);
    out.push({
      left: (s - min) * px,
      width: (e - s + 1) * px,
      label: new Date(Date.UTC(y, m, 1)).toLocaleDateString(undefined, withYear ? { month: 'short', year: 'numeric' } : { month: 'short' }),
      key: `${y}-${m}`,
    });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

function yearSegs(min: number, max: number, px: number): Seg[] {
  const out: Seg[] = [];
  let y = new Date(min * DAY).getUTCFullYear();
  while (utcDay(y, 0) <= max) {
    const first = utcDay(y, 0);
    const next = utcDay(y + 1, 0);
    const s = Math.max(first, min);
    const e = Math.min(next - 1, max);
    out.push({ left: (s - min) * px, width: (e - s + 1) * px, label: String(y), key: String(y) });
    y++;
  }
  return out;
}

function daySegs(min: number, max: number, px: number): Seg[] {
  const out: Seg[] = [];
  for (let day = min; day <= max; day++) {
    out.push({ left: (day - min) * px, width: px, label: String(new Date(day * DAY).getUTCDate()), key: String(day) });
  }
  return out;
}

function weekSegs(min: number, max: number, px: number): Seg[] {
  const out: Seg[] = [];
  const offset = (new Date(min * DAY).getUTCDay() + 6) % 7; // days since Monday
  let day = min - offset;
  while (day <= max) {
    const s = Math.max(day, min);
    const e = Math.min(day + 6, max);
    out.push({
      left: (s - min) * px,
      width: (e - s + 1) * px,
      label: new Date(s * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      key: String(day),
    });
    day += 7;
  }
  return out;
}

function quarterSegs(min: number, max: number, px: number): Seg[] {
  const out: Seg[] = [];
  const d = new Date(min * DAY);
  let y = d.getUTCFullYear();
  let q = Math.floor(d.getUTCMonth() / 3);
  while (utcDay(y, q * 3) <= max) {
    const first = utcDay(y, q * 3);
    const next = utcDay(y, q * 3 + 3);
    const s = Math.max(first, min);
    const e = Math.min(next - 1, max);
    out.push({ left: (s - min) * px, width: (e - s + 1) * px, label: `Q${q + 1}`, key: `${y}-${q}` });
    q++;
    if (q > 3) { q = 0; y++; }
  }
  return out;
}

/**
 * Timeline view (#220 redesign): records laid out as bars/milestones on a
 * zoomable horizontal axis, with a configurable left field panel (columns beside
 * the bars) that honors the view's hidden-fields control. Single-date records
 * render as milestone diamonds; a "today" marker spans the canvas.
 */
export function TimelineView({
  ws,
  db,
  config,
  readOnly,
  onPatch,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  onPatch: (updates: Partial<ViewConfig>) => void;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  const queryBody = useMemo(() => ({ ...queryBodyFromConfig(config), limit: 200 }), [config]);
  const records = useRecordsInfinite(ws, db, queryBody);
  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);

  const members = useMembers(ws, true);
  const memberNames = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user.id, m.user.name])),
    [members.data],
  );
  const memberImages = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user.id, m.user.image])),
    [members.data],
  );

  const [zoom, setZoom] = useState<Zoom>('week');
  const px = ZOOM[zoom].px;

  const fields = database.data?.fields ?? [];
  const dateFields = useMemo(() => fields.filter((f) => isDateField(f)), [fields]);
  const startField = fields.find((f) => f.id === config.start_date_field_id && isDateField(f));
  const endField = fields.find((f) => f.id === config.end_date_field_id && isDateField(f));
  const colorField = fields.find((f) => f.id === config.color_by_field_id && f.type === 'select');

  // Left-panel columns: title always, plus every non-hidden field (mirrors the
  // table view's "Hide fields" semantics; the toolbar writes hidden_field_ids).
  const leftFields = useMemo(
    () => fields.filter((f) => f.type === 'title' || (!config.hidden_field_ids.includes(f.id) && f.type !== 'created_by')),
    [fields, config.hidden_field_ids],
  );

  // Column widths: live draft during a resize drag, persisted to config on drop.
  const [draftW, setDraftW] = useState<Record<string, number>>({});
  const colW = (f: Field) => Math.round(draftW[f.id] ?? config.column_widths[f.id] ?? defaultColW(f));
  const panelWidth = leftFields.reduce((a, f) => a + colW(f), 0);

  function beginResize(id: string, startW: number, clientX: number) {
    const move = (ev: PointerEvent) => {
      setDraftW((prev) => ({ ...prev, [id]: clamp(startW + (ev.clientX - clientX), MIN_COL, MAX_COL) }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = Math.round(clamp(startW + (ev.clientX - clientX), MIN_COL, MAX_COL));
      setDraftW((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      onPatch({ column_widths: { ...config.column_widths, [id]: w } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Bars: only records with a start date get placed. A record with no end (or
  // end <= start) is a single-day milestone, not a zero-width bar.
  const bars = useMemo(() => {
    if (!startField) return [];
    const out: Array<{ row: RecordRow; start: number; end: number; milestone: boolean }> = [];
    for (const row of rows) {
      const start = toDay(fieldValue(row, startField));
      if (start === null) continue;
      const rawEnd = endField ? toDay(fieldValue(row, endField)) : null;
      const end = rawEnd !== null && rawEnd > start ? rawEnd : start;
      out.push({ row, start, end, milestone: end <= start });
    }
    return out;
  }, [rows, startField, endField]);

  const undated = rows.length - bars.length;

  const today = Math.floor(Date.now() / DAY);
  const range = useMemo(() => {
    const pad = ZOOM[zoom].pad;
    if (bars.length === 0) return { min: today - pad, max: today + pad };
    const min = Math.min(...bars.map((b) => b.start), today);
    const max = Math.max(...bars.map((b) => b.end), today);
    return { min: min - pad, max: max + pad };
  }, [bars, zoom, today]);

  const axisWidth = (range.max - range.min + 1) * px;

  const primary = useMemo(
    () => (zoom === 'month' || zoom === 'quarter' ? yearSegs(range.min, range.max, px) : monthSegs(range.min, range.max, px, true)),
    [zoom, range.min, range.max, px],
  );
  const secondary = useMemo(() => {
    if (zoom === 'day') return daySegs(range.min, range.max, px);
    if (zoom === 'week') return weekSegs(range.min, range.max, px);
    if (zoom === 'month') return monthSegs(range.min, range.max, px, false);
    return quarterSegs(range.min, range.max, px);
  }, [zoom, range.min, range.max, px]);

  // Keep "today" in view on mount and whenever the zoom reflows the axis.
  const scroller = useRef<HTMLDivElement>(null);
  function scrollToToday() {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (today - range.min) * px - 140);
  }
  useEffect(() => {
    scrollToToday();
  }, [zoom, range.min, axisWidth]);

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  // Degenerate state (#220 headline fix): never collapse into one column.
  if (!startField) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <CalendarRange className="h-8 w-8 text-faint" />
          {dateFields.length === 0 ? (
            <>
              <p className="text-sm font-medium text-ink">This database has no date field</p>
              <p className="text-[13px] text-muted">
                Add a Start (and optional Due) date field to the database, then choose it here to lay records out on a
                timeline.
              </p>
            </>
          ) : readOnly ? (
            <>
              <p className="text-sm font-medium text-ink">Timeline not configured</p>
              <p className="text-[13px] text-muted">No start-date field has been chosen for this timeline yet.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-ink">Choose the dates to lay out</p>
              <p className="text-[13px] text-muted">Pick which date field starts each bar, and optionally one that ends it.</p>
              <div className="mt-1 flex flex-col gap-2 text-left">
                <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
                  <span className="text-muted">Start date</span>
                  <select
                    className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                    value=""
                    onChange={(e) => e.target.value && onPatch({ start_date_field_id: e.target.value })}
                  >
                    <option value="">Select a field…</option>
                    {dateFields.map((f) => (
                      <option key={f.id} value={f.id}>{f.displayName}</option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Controls: zoom, date-field selectors, today */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-default px-3 py-1.5">
        <span className="mr-1 text-[12px] text-faint">Zoom</span>
        {(['day', 'week', 'month', 'quarter'] as const).map((z) => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            className={cn(
              'rounded px-2 py-0.5 text-[12px]',
              zoom === z ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover',
            )}
          >
            {ZOOM[z].label}
          </button>
        ))}

        <div className="mx-1 h-4 w-px bg-border-default" />
        <button
          onClick={scrollToToday}
          className="rounded px-2 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Today
        </button>

        {!readOnly && (
          <div className="ml-auto flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-[12px] text-faint">
              Start
              <select
                className="h-6 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={startField.id}
                onChange={(e) => onPatch({ start_date_field_id: e.target.value })}
              >
                {dateFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.displayName}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[12px] text-faint">
              End
              <select
                className="h-6 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={endField?.id ?? ''}
                onChange={(e) => onPatch({ end_date_field_id: e.target.value || undefined })}
              >
                <option value="">None</option>
                {dateFields.filter((f) => f.id !== startField.id).map((f) => (
                  <option key={f.id} value={f.id}>{f.displayName}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Scrollable canvas: left panel (sticky) + axis, sharing one vertical scroll */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div className="relative flex" style={{ minWidth: panelWidth + axisWidth }}>
          {/* Left field panel */}
          <div className="sticky left-0 z-20 shrink-0 bg-card" style={{ width: panelWidth }}>
            <div className="sticky top-0 z-10 flex border-b border-border-default bg-app" style={{ height: HEADER_H }}>
              {leftFields.map((f, i) => (
                <div
                  key={f.id}
                  className="relative flex items-center border-r border-border-default px-3 text-[11px] font-semibold uppercase tracking-wide text-faint"
                  style={{ width: colW(f) }}
                >
                  <span className="truncate">{f.displayName}</span>
                  {i < leftFields.length - 1 && (
                    <span
                      onPointerDown={(e) => {
                        e.preventDefault();
                        beginResize(f.id, colW(f), e.clientX);
                      }}
                      className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
                    />
                  )}
                </div>
              ))}
            </div>
            {bars.map(({ row }) => (
              <button
                key={row.id}
                onClick={() => router.push(recordHref(ws, db, row))}
                className="flex w-full items-stretch border-b border-border-default text-left hover:bg-hover"
                style={{ height: ROW_H }}
              >
                {leftFields.map((f) => (
                  <div
                    key={f.id}
                    className="flex min-w-0 items-center border-r border-border-default px-3"
                    style={{ width: colW(f) }}
                  >
                    <CellDisplay field={f} value={fieldValue(row, f)} memberNames={memberNames} memberImages={memberImages} />
                  </div>
                ))}
              </button>
            ))}
            {/* Full-height splitter = resize the last column (moves the panel/canvas boundary). */}
            {leftFields.length > 0 && (
              <span
                onPointerDown={(e) => {
                  e.preventDefault();
                  const last = leftFields[leftFields.length - 1]!;
                  beginResize(last.id, colW(last), e.clientX);
                }}
                className="absolute bottom-0 right-0 top-0 z-30 w-1.5 cursor-col-resize hover:bg-[var(--accent)]/40"
                title="Drag to resize"
              />
            )}
          </div>

          {/* Timeline canvas */}
          <div className="relative shrink-0" style={{ width: axisWidth }}>
            {/* Gridlines */}
            {secondary.map((s) =>
              s.left > 0 ? (
                <div
                  key={`g-${s.key}`}
                  className="pointer-events-none absolute z-0 w-px bg-border-default/40"
                  style={{ left: s.left, top: HEADER_H, bottom: 0 }}
                />
              ) : null,
            )}
            {/* Today marker */}
            {today >= range.min && today <= range.max && (
              <div
                className="pointer-events-none absolute z-[3] w-0.5 bg-[var(--accent)]/70"
                style={{ left: (today - range.min) * px, top: HEADER_H, bottom: 0 }}
              />
            )}

            {/* Two-tier axis header */}
            <div className="sticky top-0 z-10 bg-app" style={{ height: HEADER_H }}>
              <div className="relative border-b border-border-default" style={{ height: HEADER_H / 2 }}>
                {primary.map((s) => (
                  <div
                    key={s.key}
                    className="absolute flex items-center border-r border-border-default px-1.5 text-[11px] font-medium text-muted"
                    style={{ left: s.left, width: s.width, height: HEADER_H / 2 }}
                  >
                    <span className="truncate">{s.label}</span>
                  </div>
                ))}
              </div>
              <div className="relative border-b border-border-default" style={{ height: HEADER_H / 2 }}>
                {secondary.map((s) => (
                  <div
                    key={s.key}
                    className="absolute flex items-center justify-center border-r border-border-default text-[10px] tabular-nums text-faint"
                    style={{ left: s.left, width: s.width, height: HEADER_H / 2 }}
                  >
                    {s.width > 18 ? s.label : ''}
                  </div>
                ))}
              </div>
            </div>

            {/* Bars */}
            {bars.map(({ row, start, end, milestone }) => {
              const color = (colorField && optionColor(colorField, row.values[colorField.apiName])) || 'var(--accent)';
              const x = (start - range.min) * px;
              if (milestone) {
                const size = 14;
                return (
                  <div key={row.id} className="relative border-b border-border-default" style={{ height: ROW_H }}>
                    <button
                      onClick={() => router.push(recordHref(ws, db, row))}
                      title={row.title || 'Untitled'}
                      className="absolute rounded-[3px] shadow-sm hover:brightness-110"
                      style={{
                        left: x + px / 2 - size / 2,
                        top: ROW_H / 2 - size / 2,
                        width: size,
                        height: size,
                        transform: 'rotate(45deg)',
                        backgroundColor: color,
                      }}
                    />
                    <span
                      className="pointer-events-none absolute truncate text-[11px] text-ink-secondary"
                      style={{ left: x + px / 2 + size, top: ROW_H / 2 - 8, maxWidth: 220 }}
                    >
                      {row.title || 'Untitled'}
                    </span>
                  </div>
                );
              }
              const width = Math.max(px, (end - start + 1) * px);
              return (
                <div key={row.id} className="relative border-b border-border-default" style={{ height: ROW_H }}>
                  <button
                    onClick={() => router.push(recordHref(ws, db, row))}
                    title={row.title || 'Untitled'}
                    className="absolute flex items-center overflow-hidden rounded-md text-left text-[11px] text-[var(--text-on-dark)] shadow-sm hover:brightness-110"
                    style={{ left: x, top: ROW_H / 2 - 11, width, height: 22, backgroundColor: color }}
                  >
                    <span className="truncate px-1.5">{row.title || 'Untitled'}</span>
                  </button>
                </div>
              );
              // TODO(#220): OPTIONAL — dependency lines from blocked_by/blocker_for
              // relations, and drag-to-reschedule/resize (persist to the date field).
            })}
          </div>
        </div>
      </div>

      {undated > 0 && (
        <div className="border-t border-border-default px-3 py-1.5 text-[12px] text-faint">
          {undated} record{undated === 1 ? '' : 's'} without a {startField.displayName} date {undated === 1 ? 'is' : 'are'} hidden.
        </div>
      )}
    </div>
  );
}
