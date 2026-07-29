/**
 * Dashboard metric-tile aggregation (MN-225 / #168, Phase 1).
 *
 * Pure functions that compute one KPI tile's aggregate over a set of records.
 * Kept framework-free so they can be unit-tested directly and reused by the
 * dashboard view without pulling in React. Semantics deliberately match the
 * server-side rollup engine (SQL aggregate semantics):
 *   - count  → number of records (0+); the target field is ignored.
 *   - sum/avg/min/max → aggregate over the numeric values of the target field,
 *     skipping records whose value is null/blank/non-numeric. When the numeric
 *     set is empty these return `null` (SQL SUM/AVG/MIN/MAX over no rows), which
 *     the UI renders as an em dash. `count` of zero records is `0`, never null.
 */

export type TileOp = 'count' | 'sum' | 'avg' | 'min' | 'max';

export const TILE_OPS: readonly TileOp[] = ['count', 'sum', 'avg', 'min', 'max'];

/** count needs no field; the rest aggregate a numeric target field. */
export function opNeedsField(op: TileOp): boolean {
  return op !== 'count';
}

const OP_LABEL: Record<TileOp, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Avg',
  min: 'Min',
  max: 'Max',
};

/** Display label for an aggregation op (e.g. 'sum' → 'Sum'). */
export function opLabel(op: TileOp): string {
  return OP_LABEL[op];
}

/**
 * Coerce a raw record value to a finite number, or null if it isn't numeric.
 * Accepts JS numbers and numeric strings (e.g. "12.5"); rejects booleans,
 * objects, empty strings, NaN, and ±Infinity so non-numeric fields (select,
 * relation, …) never contaminate a sum.
 */
export function toNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Compute one tile's aggregate over `records`. For non-count ops, reads each
 * record's `values[fieldApiName]` and coerces it with `toNumeric`. Returns null
 * when a numeric-op tile has no field, or no record carries a numeric value.
 */
export function computeTileValue(
  op: TileOp,
  fieldApiName: string | undefined,
  records: ReadonlyArray<{ values: Record<string, unknown> }>,
): number | null {
  if (op === 'count') return records.length;
  if (!fieldApiName) return null;

  const nums: number[] = [];
  for (const rec of records) {
    const n = toNumeric(rec.values[fieldApiName]);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) return null;

  switch (op) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

/**
 * Human label for a tile when the user hasn't typed one. E.g.
 * "Count of records", "Sum of Amount". Falls back to the raw api_name when the
 * display name is unknown.
 */
export function defaultTileLabel(op: TileOp, fieldDisplayName?: string): string {
  if (op === 'count') return 'Count of records';
  return `${opLabel(op)} of ${fieldDisplayName ?? 'field'}`;
}

/**
 * Format a computed tile value for display. `null` → em dash. Averages get up
 * to 2 decimal places; whole numbers stay integer. Uses locale grouping so a
 * KPI reads "1,234" not "1234".
 */
export function formatTileValue(value: number | null): string {
  if (value === null) return '—';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
