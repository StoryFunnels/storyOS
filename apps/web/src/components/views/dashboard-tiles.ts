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
 *
 * #387 — kept for the places that genuinely have no source to name (a tile whose
 * database is not configured yet). Prefer `defaultBlockLabel` everywhere a source
 * IS known: derived from the OP alone, this returns "Count of records" for every
 * count tile in existence, which is exactly the founder's screenshot.
 */
export function defaultTileLabel(op: TileOp, fieldDisplayName?: string): string {
  if (op === 'count') return 'Count of records';
  return `${opLabel(op)} of ${fieldDisplayName ?? 'field'}`;
}

/**
 * #387 — the default name for a tile or chart, derived from WHAT it measures.
 *
 * The founder's dashboard showed two tiles both headed "Count of records",
 * reading 383 and 5, distinguishable only by the database dropdown in the editor
 * beneath each one. #385's view mode correctly hides that dropdown — so without
 * this, view mode would make the screen strictly LESS informative than the
 * problem it fixes. That is why the two ship together.
 *
 * The database name leads because it is the part that DISTINGUISHES tiles; the
 * operation is the part that repeats. "Issues · Count" and "Docs · Count" tell
 * you something; "Count of records" twice does not.
 *
 * Returns null when there is no source to name — the caller renders its
 * unconfigured state rather than inventing a label for a tile measuring nothing
 * (#305: unconfigured is not invalid, and a confident label on an unconfigured
 * tile is how a bare 0 gets mistaken for an answer).
 */
export function defaultBlockLabel(input: {
  sourceName?: string;
  op: TileOp;
  fieldDisplayName?: string;
  /** Chart only — the field records are grouped by. */
  groupByDisplayName?: string;
}): string | null {
  if (!input.sourceName) return null;
  const measure =
    input.op === 'count' ? 'Count' : `${opLabel(input.op)} of ${input.fieldDisplayName ?? 'field'}`;
  // A chart's shape is "<measure> by <group>", which reads better with the
  // source first than the measure-by-group phrasing wrapped in a database name.
  const what = input.groupByDisplayName ? `${measure} by ${input.groupByDisplayName}` : measure;
  return `${input.sourceName} · ${what}`;
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

/**
 * #388 — how a number reads against its target.
 *
 * "383" is not information; "383 of 400" is. This turns the pair into the three
 * things a reader needs: how far along, whether that is good, and whether to say
 * anything at all.
 */
export interface TargetProgress {
  /** 0..1, clamped. Past the target stays 1 so the bar cannot overflow. */
  ratio: number;
  /** Percent of target, NOT clamped — "120% of target" is the useful part. */
  percent: number;
  /** Whether the reader should feel good about this. */
  tone: 'good' | 'bad' | 'neutral';
  /** Rendered beside the number, e.g. "of 400". */
  label: string;
}

/**
 * `null` means render NO comparison — never a zero and never a 100% swing.
 *
 * #388 names this trap directly: "A missing or empty previous period renders as
 * no comparison — never 0, never an infinite percentage. A dashboard that reports
 * a dramatic swing because last period had no data is actively misleading."
 * The same reasoning applies to a target of zero, which would divide by zero and
 * produce Infinity — a tile confidently reporting "∞% of target".
 */
export function targetProgress(
  value: number | null,
  target: number | undefined,
  direction: 'up' | 'down' = 'up',
): TargetProgress | null {
  if (value == null || target == null || !Number.isFinite(target) || target === 0) return null;

  const percent = (value / target) * 100;
  const ratio = Math.max(0, Math.min(1, value / target));

  /*
   * Direction is why this is not a one-liner. More revenue is good; more overdue
   * invoices is bad. Colouring by "is the number big" would be confidently wrong
   * half the time, which is worse than no colour at all — so the tile carries
   * which way is desirable and this respects it.
   *
   * `down` means the target is a CEILING: at or under it is good.
   */
  const met = direction === 'up' ? value >= target : value <= target;
  const close = direction === 'up' ? value >= target * 0.9 : value <= target * 1.1;
  const tone: TargetProgress['tone'] = met ? 'good' : close ? 'neutral' : 'bad';

  return {
    ratio,
    percent,
    tone,
    label: direction === 'up' ? `of ${formatTileValue(target)}` : `limit ${formatTileValue(target)}`,
  };
}
