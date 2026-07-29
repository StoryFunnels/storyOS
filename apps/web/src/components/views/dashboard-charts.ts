/**
 * Dashboard chart / grouped-table aggregation (MN-225 / #168, Phase 2).
 *
 * Pure, framework-free functions that turn a set of records into ONE series of
 * grouped aggregates — the data behind a bar/line/pie chart or a grouped table.
 * Kept React-free so they can be unit-tested directly. Semantics reuse the
 * metric-tile aggregation (`computeTileValue`) per group, so a widget's numbers
 * match the tiles' and the server-side rollup engine's SQL semantics.
 *
 * Grouping rules (client-side, over the same grant-scoped record set tiles use):
 *   - A record's group key is derived from `values[groupByApiName]`.
 *   - null / undefined / empty-string → the "empty" bucket (key === null).
 *   - multi_select values are arrays: a record contributes to EACH selected
 *     option's group (so group counts can exceed the record count — expected).
 *   - date fields are bucketed to the calendar day (YYYY-MM-DD) so a series has
 *     one point per day rather than per timestamp.
 *   - everything else groups by the raw scalar value stringified.
 */

import { computeTileValue, type TileOp } from './dashboard-tiles';

export type ChartWidgetType = 'bar' | 'line' | 'pie' | 'grouped_table';

export const CHART_WIDGET_TYPES: readonly ChartWidgetType[] = [
  'bar',
  'line',
  'pie',
  'grouped_table',
];

export interface Measure {
  op: TileOp;
  field_api_name?: string;
}

/** One record shape the aggregation needs (a subset of RecordRow). */
export interface AggRecord {
  values: Record<string, unknown>;
}

/** One computed point in a widget's series. */
export interface SeriesPoint {
  /** Raw group key: an option id, a YYYY-MM-DD day, a stringified scalar, or
   *  null for the empty bucket. Stable across renders for React keys. */
  key: string | null;
  /** Human label for the axis / legend / table row. */
  label: string;
  /** Aggregated measure value for the group. null when a numeric op has no
   *  numeric values in the group (matches SQL SUM/AVG/MIN/MAX over no rows). */
  value: number | null;
  /** Number of records in the group (before measure aggregation). */
  count: number;
}

/** Label used for the empty / no-value bucket. */
export const EMPTY_GROUP_LABEL = '(Empty)';

/**
 * Bucket a date value to its calendar day (YYYY-MM-DD). Accepts ISO strings and
 * anything `Date` can parse; returns null when it isn't a valid date (so the
 * record falls into the empty bucket rather than a bogus group).
 */
export function dateDayKey(value: unknown): string | null {
  if (value == null || value === '') return null;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;
  // Use the UTC date so the same instant always buckets the same way regardless
  // of the viewer's timezone — group boundaries must be deterministic.
  return d.toISOString().slice(0, 10);
}

/**
 * The group key(s) a single record contributes to for a given group-by field.
 * Returns an array because multi_select records land in several groups; scalar
 * fields return a single-element array. An empty/absent value yields `[null]`.
 */
export function groupKeysForRecord(value: unknown, fieldType: string): (string | null)[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? [null] : value.map((v) => (v == null ? null : String(v)));
  }
  if (value == null || value === '') return [null];
  if (fieldType === 'date') return [dateDayKey(value)];
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  return [String(value)];
}

/**
 * Compute a widget's full series from records.
 *
 * @param records         the (already filtered, grant-scoped) record set
 * @param groupByApiName  field api_name to group by
 * @param groupByType     that field's type (drives date bucketing / arrays)
 * @param measure         count, or sum/avg/min/max of a number field
 * @param labelFor        maps a raw group key → display label (e.g. select
 *                        option id → option label). null keys always render as
 *                        EMPTY_GROUP_LABEL regardless of this resolver.
 *
 * Ordering: date group-bys sort chronologically (natural for a line/bar over
 * time); every other field sorts by descending value, then count, then label —
 * so the biggest bar/slice reads first. The empty bucket always sorts last.
 */
export function computeChartSeries(
  records: ReadonlyArray<AggRecord>,
  groupByApiName: string | undefined,
  groupByType: string,
  measure: Measure,
  labelFor?: (key: string) => string,
): SeriesPoint[] {
  if (!groupByApiName) return [];

  // Bucket records by group key, preserving each group's records so the measure
  // can aggregate them exactly the way a tile aggregates the whole set.
  const groups = new Map<string | null, AggRecord[]>();
  for (const rec of records) {
    for (const key of groupKeysForRecord(rec.values[groupByApiName], groupByType)) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(rec);
      else groups.set(key, [rec]);
    }
  }

  const points: SeriesPoint[] = [];
  for (const [key, recs] of groups) {
    const label = key === null ? EMPTY_GROUP_LABEL : labelFor?.(key) ?? key;
    points.push({
      key,
      label,
      value: computeTileValue(measure.op, measure.field_api_name, recs),
      count: recs.length,
    });
  }

  const isDate = groupByType === 'date';
  points.sort((a, b) => {
    // Empty bucket always last.
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    if (isDate) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    const av = a.value ?? Number.NEGATIVE_INFINITY;
    const bv = b.value ?? Number.NEGATIVE_INFINITY;
    if (bv !== av) return bv - av;
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });

  return points;
}

/** True when the measure needs a target number field (everything but count). */
export function measureNeedsField(op: TileOp): boolean {
  return op !== 'count';
}
