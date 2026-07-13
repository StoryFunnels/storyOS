'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { recordHref } from '@/lib/records';
import { OPTION_COLORS, fieldValue, isDateField } from '../table-view/cells';
import { useDatabase, useRecordsInfinite } from '../table-view/use-table-data';
import type { RecordRow } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

const DAY = 86_400_000;
const ZOOM: Record<string, { px: number; label: string }> = {
  day: { px: 34, label: 'Day' },
  week: { px: 16, label: 'Week' },
  month: { px: 5, label: 'Month' },
};
const ROW_H = 36;
const LABEL_W = 200;

function toDay(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / DAY);
}

/** Timeline view (MN-092 v1, read): each record is a bar between its start and end
 * date fields on a zoomable horizontal axis, with a today marker. Drag-to-reschedule
 * is the next increment (tracked in MN-092). */
export function TimelineView({
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
  const queryBody = useMemo(() => ({ ...queryBodyFromConfig(config), limit: 200 }), [config]);
  const records = useRecordsInfinite(ws, db, queryBody);
  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);

  const [zoom, setZoom] = useState<'day' | 'week' | 'month'>('week');
  const pxPerDay = ZOOM[zoom]!.px;

  const startField = database.data?.fields.find((f) => f.id === config.start_date_field_id && isDateField(f));
  const endField = database.data?.fields.find((f) => f.id === config.end_date_field_id && isDateField(f));
  const colorField = database.data?.fields.find((f) => f.type === 'select');

  const bars = useMemo(() => {
    if (!startField) return [];
    return rows
      .map((row) => {
        const start = toDay(fieldValue(row, startField) as string | undefined);
        if (start === null) return null;
        const end = endField ? toDay(fieldValue(row, endField) as string | undefined) ?? start : start;
        return { row, start, end: Math.max(start, end) };
      })
      .filter((b): b is { row: RecordRow; start: number; end: number } => b !== null);
  }, [rows, startField, endField]);

  const range = useMemo(() => {
    const today = Math.floor(Date.now() / DAY);
    if (bars.length === 0) return { min: today - 15, max: today + 15 };
    const min = Math.min(...bars.map((b) => b.start), today);
    const max = Math.max(...bars.map((b) => b.end), today);
    return { min: min - 3, max: max + 3 };
  }, [bars]);

  if (!startField) {
    return (
      <p className="p-6 text-sm text-muted">
        This timeline has no start-date field. Edit the view and pick a date field.
      </p>
    );
  }

  const totalDays = range.max - range.min + 1;
  const axisWidth = totalDays * pxPerDay;
  const today = Math.floor(Date.now() / DAY);

  // Month header segments.
  const months: Array<{ left: number; width: number; label: string }> = [];
  {
    let cursor = range.min;
    while (cursor <= range.max) {
      const d = new Date(cursor * DAY);
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY;
      const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY;
      const segStart = Math.max(cursor, monthStart);
      const segEnd = Math.min(range.max, nextMonth - 1);
      months.push({
        left: (segStart - range.min) * pxPerDay,
        width: (segEnd - segStart + 1) * pxPerDay,
        label: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
      });
      cursor = nextMonth;
    }
  }

  const barColor = (row: RecordRow): string => {
    if (colorField) {
      const opt = colorField.options?.find((o) => o.id === row.values[colorField.apiName]);
      if (opt) return OPTION_COLORS[opt.color] ?? OPTION_COLORS.gray!;
    }
    return 'var(--accent)';
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border-default px-3 py-1.5">
        <span className="mr-2 text-[12px] text-faint">Zoom</span>
        {(['day', 'week', 'month'] as const).map((z) => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            className={cn(
              'rounded px-2 py-0.5 text-[12px]',
              zoom === z ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover',
            )}
          >
            {ZOOM[z]!.label}
          </button>
        ))}
        {bars.length === 0 && <span className="ml-3 text-[12px] text-faint">No records with a {startField.displayName} date.</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: LABEL_W + axisWidth }}>
          {/* Month header */}
          <div className="sticky top-0 z-20 flex h-7 border-b border-border-default bg-app">
            <div className="sticky left-0 z-10 shrink-0 border-r border-border-default bg-app" style={{ width: LABEL_W }} />
            <div className="relative" style={{ width: axisWidth }}>
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-7 border-r border-border-default px-1.5 text-[11px] leading-7 text-muted"
                  style={{ left: m.left, width: m.width }}
                >
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {/* Today marker */}
          {today >= range.min && today <= range.max && (
            <div
              className="pointer-events-none absolute bottom-0 top-7 z-10 w-px bg-[var(--accent)]/60"
              style={{ left: LABEL_W + (today - range.min) * pxPerDay }}
            />
          )}

          {/* Rows */}
          {bars.map(({ row, start, end }) => (
            <div key={row.id} className="flex border-b border-border-default" style={{ height: ROW_H }}>
              <div
                className="sticky left-0 z-10 flex shrink-0 items-center truncate border-r border-border-default bg-card px-3 text-[13px] text-ink"
                style={{ width: LABEL_W }}
              >
                <span className="truncate">{row.title || 'Untitled'}</span>
              </div>
              <div className="relative" style={{ width: axisWidth }}>
                <button
                  onClick={() => router.push(recordHref(ws, db, row))}
                  className="absolute top-1.5 h-6 rounded-md text-left text-[11px] text-[var(--text-on-dark)] shadow-sm hover:brightness-110"
                  style={{
                    left: (start - range.min) * pxPerDay,
                    width: Math.max(pxPerDay, (end - start + 1) * pxPerDay),
                    backgroundColor: barColor(row),
                  }}
                  title={row.title}
                >
                  <span className="truncate px-1.5 leading-6">{row.title || 'Untitled'}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
