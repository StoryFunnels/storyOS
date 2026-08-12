/**
 * Date bucketing for board columns (#307, slice of #225).
 *
 * A board grouped by a date field has one column per PERIOD, derived from the data
 * rather than from schema options. Three operations, kept together so the key, its
 * label and its write-back value can never disagree:
 *
 *   dateBucketKey   value  → stable key   ("2026-Q3")
 *   bucketLabel     key    → display text ("Q3 2026")
 *   bucketStartISO  key    → the date written back when a card is dragged in
 *
 * All arithmetic is UTC, matching `dateDayKey` in dashboard-charts.ts — group
 * boundaries must not shift with the viewer's timezone, or two people looking at the
 * same board would see a card in different columns.
 */

export const DATE_GRANULARITIES = ['week', 'month', 'quarter', 'year'] as const;
export type DateGranularity = (typeof DATE_GRANULARITIES)[number];

export function isDateGranularity(value: unknown): value is DateGranularity {
  return typeof value === 'string' && (DATE_GRANULARITIES as readonly string[]).includes(value);
}

/** Monday of the ISO week containing `d` (UTC). ISO weeks start Monday. */
function isoWeekStart(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay(): 0=Sun..6=Sat → shift so Monday is 0.
  const dayFromMonday = (out.getUTCDay() + 6) % 7;
  out.setUTCDate(out.getUTCDate() - dayFromMonday);
  return out;
}

/**
 * The bucket key for one record's date value, or null when there's no usable date
 * (those records land in the "No date" column rather than a bogus bucket).
 *
 * Keys are chosen to sort chronologically as plain strings, so column ordering is a
 * string sort and never a second date parse.
 */
export function dateBucketKey(value: unknown, granularity: DateGranularity): string | null {
  if (value == null || value === '') return null;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;

  const y = d.getUTCFullYear();
  switch (granularity) {
    case 'year':
      return String(y);
    case 'quarter':
      return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case 'month':
      return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'week': {
      // Keyed by the week's Monday, so the key is both sortable and directly
      // convertible back to a date — no ISO week-number edge cases at year ends.
      const start = isoWeekStart(d);
      return `${start.getUTCFullYear()}-W${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(
        start.getUTCDate(),
      ).padStart(2, '0')}`;
    }
  }
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Human label for a bucket key. Falls back to the raw key rather than throwing. */
export function bucketLabel(key: string, granularity: DateGranularity): string {
  switch (granularity) {
    case 'year':
      return key;
    case 'quarter': {
      const [y, q] = key.split('-');
      return q && y ? `${q} ${y}` : key;
    }
    case 'month': {
      const [y, m] = key.split('-');
      const idx = Number(m) - 1;
      return y && MONTHS[idx] ? `${MONTHS[idx]} ${y}` : key;
    }
    case 'week': {
      const start = bucketStartISO(key, 'week');
      if (!start) return key;
      const d = new Date(start);
      return `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    }
  }
}

/**
 * The date written back when a card is dropped into a bucket: the FIRST day of that
 * period, as `YYYY-MM-DD`. Dropping a card into "Q3 2026" sets 2026-07-01 — the
 * period's start is the only choice that round-trips (re-bucketing it lands in the
 * same column).
 */
export function bucketStartISO(key: string, granularity: DateGranularity): string | null {
  switch (granularity) {
    case 'year':
      return /^\d{4}$/.test(key) ? `${key}-01-01` : null;
    case 'quarter': {
      const m = /^(\d{4})-Q([1-4])$/.exec(key);
      if (!m) return null;
      const month = (Number(m[2]) - 1) * 3 + 1;
      return `${m[1]}-${String(month).padStart(2, '0')}-01`;
    }
    case 'month': {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      return m ? `${m[1]}-${m[2]}-01` : null;
    }
    case 'week': {
      const m = /^(\d{4})-W(\d{2})-(\d{2})$/.exec(key);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
  }
}

/**
 * The columns a board should show: every bucket present in the data, chronologically.
 *
 * Derived from the data on purpose — a date axis has no schema to enumerate, and
 * emitting every period between the earliest and latest record would produce an
 * unbounded row of empty columns the moment one record has a far-future date.
 */
export function bucketColumnsFor(
  values: readonly unknown[],
  granularity: DateGranularity,
): string[] {
  const keys = new Set<string>();
  for (const v of values) {
    const key = dateBucketKey(v, granularity);
    if (key !== null) keys.add(key);
  }
  return [...keys].sort();
}
