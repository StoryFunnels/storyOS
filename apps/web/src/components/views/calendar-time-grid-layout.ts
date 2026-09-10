/**
 * #470 — pure logic for the calendar's day/week hour-grid mode, split out from
 * the DOM the same way range-select.ts/paste.ts keep table-view.tsx's non-DOM
 * logic separately testable.
 */

export const MINUTES_PER_DAY = 24 * 60;
/** #470 AC — an event with no end field gets a fixed display duration, never
 *  stored. One hour reads clearly on an hour axis without a real end time. */
export const DEFAULT_DURATION_MINUTES = 60;
/** Never render a sliver too thin to read or click, regardless of how short
 *  the real (or clamped) duration is. */
export const MIN_EVENT_MINUTES = 20;

/**
 * Splits a record's raw date-field value into its calendar day key + time of
 * day. `raw.length <= 10` is a bare `YYYY-MM-DD` — a date field with no time
 * component (#289's `include_time: false`) — which is an ALL-DAY record, not
 * an event at minute 0; the two must never be conflated (AC5).
 */
export function parseDateValue(raw: string): { dayKey: string; minutes: number | null } {
  if (raw.length <= 10) return { dayKey: raw, minutes: null };
  const d = new Date(raw);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { dayKey, minutes: d.getHours() * 60 + d.getMinutes() };
}

export interface TimedEvent {
  id: string;
  /** Minutes since midnight of its OWN day. */
  startMinutes: number;
  /** > startMinutes; may exceed MINUTES_PER_DAY for a multi-day span — callers
   *  clip per-day before layout, this function only lays out ONE day. */
  endMinutes: number;
}

export interface EventLayout {
  /** 0-based column within this event's overlap cluster. */
  col: number;
  /** Total columns in that cluster — width = 1 / cols. */
  cols: number;
}

/**
 * Classic calendar day-view overlap layout: events overlapping in time share
 * the day's width side-by-side rather than stacking illegibly (AC4).
 *
 * Two events "overlap" when their [start, end) intervals intersect. A maximal
 * chain of pairwise-reachable overlaps (A overlaps B, B overlaps C — even
 * where A and C never directly touch) forms one CLUSTER, and every event in a
 * cluster shares that cluster's column COUNT, not just the width its direct
 * neighbours would suggest — otherwise a later event can end up wider than
 * the gap its earlier neighbours actually left for it.
 */
export function layoutDayEvents(events: TimedEvent[]): Map<string, EventLayout> {
  const layout = new Map<string, EventLayout>();
  if (events.length === 0) return layout;
  const sorted = [...events].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );

  let clusterStart = 0;
  let clusterEnd = sorted[0]!.endMinutes;
  // Per column, the end time of the last event placed there so far.
  const columnsEndTime: number[] = [];
  const columnOf = new Map<string, number>();

  function flushCluster(endIdx: number) {
    const cols = columnsEndTime.length;
    for (let i = clusterStart; i < endIdx; i++) {
      const ev = sorted[i]!;
      layout.set(ev.id, { col: columnOf.get(ev.id)!, cols });
    }
    columnsEndTime.length = 0;
    columnOf.clear();
  }

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]!;
    if (i > clusterStart && ev.startMinutes >= clusterEnd) {
      flushCluster(i);
      clusterStart = i;
      clusterEnd = ev.endMinutes;
    }
    let placed = -1;
    for (let c = 0; c < columnsEndTime.length; c++) {
      if (columnsEndTime[c]! <= ev.startMinutes) {
        placed = c;
        break;
      }
    }
    if (placed === -1) {
      placed = columnsEndTime.length;
      columnsEndTime.push(0);
    }
    columnsEndTime[placed] = ev.endMinutes;
    columnOf.set(ev.id, placed);
    clusterEnd = Math.max(clusterEnd, ev.endMinutes);
  }
  flushCluster(sorted.length);
  return layout;
}

/**
 * The new ISO value to write back after dragging an event by `deltaMinutes`
 * (vertical, within a day) and `deltaDays` (horizontal, week mode only).
 * Preserves the ORIGINAL value's shape: a bare date stays a bare date (an
 * all-day record dragged to a new day is still all-day, AC8-adjacent — dragging
 * never invents a time that wasn't there), a datetime keeps carrying one.
 */
export function shiftDateValue(raw: string, deltaDays: number, deltaMinutes: number): string {
  const hasTime = raw.length > 10;
  const base = hasTime ? new Date(raw) : new Date(`${raw}T00:00:00`);
  const shifted = new Date(base.getTime() + (deltaDays * MINUTES_PER_DAY + deltaMinutes) * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
  if (!hasTime) return dateStr;
  return `${dateStr}T${pad(shifted.getHours())}:${pad(shifted.getMinutes())}:00`;
}
