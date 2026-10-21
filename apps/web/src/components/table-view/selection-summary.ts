import { computeTileValue } from '../views/dashboard-tiles';
import type { TileOp } from '../views/dashboard-tiles';
import { formatNumberValue } from './cells';

/**
 * #580 — the throwaway readout over a cell selection. Nothing here defines,
 * names or stores anything: it is a pure function of the cells currently
 * selected.
 *
 * The aggregation is NOT re-implemented. `computeTileValue` already carries the
 * rollup engine's semantics (count of nothing is 0; sum/avg/min/max over no
 * numeric value are null, rendered as an em dash), so this feeds it synthetic
 * records and inherits the edge behaviour instead of restating it.
 *
 * The vocabulary is rollupConfigSchema's numeric ops: count, sum, avg, min, max.
 * `first`/`last`/`collect` are not offered — they pick or gather a record, which
 * a bag of selected cells has no order or relation to speak of.
 */

export const SELECTION_OPS: readonly TileOp[] = ['count', 'sum', 'avg', 'min', 'max'];

interface SummaryField {
  type: string;
  config: Record<string, unknown>;
}

export interface SelectedCell<F extends SummaryField = SummaryField> {
  field: F;
  value: unknown;
}

const NUMERIC_ROLLUP_OPS = new Set(['count', 'sum', 'avg', 'min', 'max']);

/** Fields whose cells hold a number (and so take part in sum/avg/min/max). */
export function isNumericField(field: SummaryField): boolean {
  if (field.type === 'number') return true;
  if (field.type === 'formula') return field.config['result_type'] === 'number';
  if (field.type === 'rollup') return NUMERIC_ROLLUP_OPS.has(String(field.config['op']));
  return false;
}

/** A cell with something in it: not null/undefined, not a blank string, not an empty list. */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export interface SelectionSummary {
  /** Cells in the rectangle, filled or not. */
  cells: number;
  /** Count: the filled cells, of any type. */
  count: number;
  /** Sum/avg/min/max over the numeric cells; null when there are none (same as a rollup over no rows). */
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** The one field every numeric cell came from, or null when they span several. Drives the number format. */
  singleField: SummaryField | null;
}

export function summarizeSelection(cells: ReadonlyArray<SelectedCell>): SelectionSummary {
  const filled = cells.filter((c) => isFilled(c.value));
  const numeric = filled.filter((c) => isNumericField(c.field));
  const asRecords = (list: ReadonlyArray<SelectedCell>) => list.map((c) => ({ values: { v: c.value } }));
  const over = (op: TileOp) => computeTileValue(op, 'v', asRecords(numeric));
  const fields = new Set(numeric.map((c) => c.field));
  return {
    cells: cells.length,
    count: computeTileValue('count', undefined, asRecords(filled)) ?? 0,
    sum: over('sum'),
    avg: over('avg'),
    min: over('min'),
    max: over('max'),
    singleField: fields.size === 1 ? [...fields][0]! : null,
  };
}

/**
 * Float noise (0.1 + 0.2) must not reach a status bar. Ten decimals is far past
 * any real field's precision and well inside what a double holds exactly.
 */
function tidy(n: number): number {
  return Number(n.toFixed(10));
}

/** `null` is the rollup's "no value", shown as an em dash, never as 0. */
export function formatSelectionValue(summary: SelectionSummary, op: TileOp): string {
  const raw = summary[op === 'count' ? 'count' : op];
  if (raw === null) return '—';
  if (op === 'count') return new Intl.NumberFormat().format(raw);
  const n = tidy(raw);
  // One source field: show it the way its column does (currency, percent, precision).
  if (summary.singleField) return formatNumberValue(summary.singleField, n);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(n);
}
