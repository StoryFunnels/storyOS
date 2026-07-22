/**
 * #296: the pure pieces of cell range selection — pulled out of table-view.tsx
 * (a 700+ line component) so they're unit-testable without a DOM, the same way
 * MN-135 did for paste.ts/cell-text.ts.
 *
 * The point of all three functions here is that mouse drag-select (#296) and
 * keyboard shift+click/shift+arrow (MN-285) are two *inputs* into one shared
 * mechanism, not two competing selection concepts: both ultimately just call
 * `setCursor`/`setRangeEnd` with a `Cursor`, and `computeRangeBounds` below is
 * the single place that turns whatever pair of corners resulted into the
 * normalized rectangle every range-aware feature (the highlight, copyRange,
 * pasteRange) reads.
 */

export interface Cursor {
  row: number;
  col: number;
}

export interface RangeBounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/**
 * Normalizes an anchor (`cursor`) + far corner (`rangeEnd`) — regardless of
 * whether `rangeEnd` was set by a mouse drag, a shift+click, or a shift+arrow
 * — into a top-left/bottom-right rectangle. `null` whenever there's no active
 * range, so every single-cell code path stays unaffected (MN-285).
 */
export function computeRangeBounds(cursor: Cursor | null, rangeEnd: Cursor | null): RangeBounds | null {
  if (!cursor || !rangeEnd) return null;
  return {
    r0: Math.min(cursor.row, rangeEnd.row),
    r1: Math.max(cursor.row, rangeEnd.row),
    c0: Math.min(cursor.col, rangeEnd.col),
    c1: Math.max(cursor.col, rangeEnd.col),
  };
}

/**
 * A mousedown-on-a-cell only becomes a range-select drag once the pointer has
 * actually moved — otherwise it's an ordinary click (cell selection, checkbox
 * toggle, single-click editing, a relation chip's own link, …) and must stay
 * exactly as it was before #296. `threshold` is exclusive on both axes: moving
 * *up to* the threshold is still a click; a real drag needs to clear it.
 */
export function hasCrossedDragThreshold(
  anchor: { x: number; y: number },
  x: number,
  y: number,
  threshold: number,
): boolean {
  return Math.abs(x - anchor.x) >= threshold || Math.abs(y - anchor.y) >= threshold;
}

/**
 * Reads the `data-row`/`data-col` a cell's DOM node carries back into a
 * `Cursor` — pulled out of the `document.elementFromPoint` lookup so the
 * string→number parsing (the only part with any logic worth breaking) is
 * testable without a DOM.
 */
export function parseCellDataset(dataset: { row?: string; col?: string } | undefined): Cursor | null {
  if (!dataset) return null;
  const row = Number(dataset.row);
  const col = Number(dataset.col);
  return Number.isNaN(row) || Number.isNaN(col) ? null : { row, col };
}
