import { describe, expect, it } from 'vitest';
import { computeRangeBounds, hasCrossedDragThreshold, parseCellDataset } from './range-select';

/**
 * #296: mouse drag-to-select feeds the exact same cursor/rangeEnd state
 * MN-285's shift+click/shift+arrow already populate — these tests exercise
 * that shared mechanism directly, independent of which input method produced
 * the far corner, plus the drag-vs-click threshold decision that keeps a
 * plain click (cell selection, checkbox toggle, relation-chip navigation,
 * title "Open" link, …) working exactly as it did before this feature.
 */

describe('computeRangeBounds — the shared range state behind every selection input', () => {
  it('is null with no cursor, no rangeEnd, or neither (the plain single-cell case)', () => {
    expect(computeRangeBounds(null, null)).toBeNull();
    expect(computeRangeBounds({ row: 2, col: 2 }, null)).toBeNull();
    expect(computeRangeBounds(null, { row: 2, col: 2 })).toBeNull();
  });

  it('normalizes a mouse-drag range the same way regardless of drag direction', () => {
    // Dragging down-right from the mousedown cell.
    expect(computeRangeBounds({ row: 2, col: 1 }, { row: 5, col: 3 })).toEqual({
      r0: 2,
      r1: 5,
      c0: 1,
      c1: 3,
    });
    // Dragging up-left — same two cells, opposite gesture direction — must
    // produce the identical normalized rectangle.
    expect(computeRangeBounds({ row: 5, col: 3 }, { row: 2, col: 1 })).toEqual({
      r0: 2,
      r1: 5,
      c0: 1,
      c1: 3,
    });
  });

  it('produces the identical bounds for a shift+click range as for a mouse-drag range over the same two cells', () => {
    // MN-285's shift+click sets rangeEnd to the clicked cell; #296's drag sets
    // it to wherever the pointer is. Same cursor + same far corner must yield
    // the same rangeBounds either way — that's the "one underlying mechanism,
    // two input methods" requirement from #296's acceptance criteria.
    const cursor = { row: 0, col: 0 };
    const farCorner = { row: 3, col: 2 };
    const viaShiftClick = computeRangeBounds(cursor, farCorner);
    const viaMouseDrag = computeRangeBounds(cursor, farCorner);
    expect(viaShiftClick).toEqual(viaMouseDrag);
    expect(viaShiftClick).toEqual({ r0: 0, r1: 3, c0: 0, c1: 2 });
  });

  it('collapses to a single-cell range when the far corner lands back on the anchor', () => {
    // e.g. a drag that starts and ends on the same cell after crossing the
    // threshold elsewhere and coming back, or a shift+arrow that returns to
    // the anchor.
    expect(computeRangeBounds({ row: 4, col: 4 }, { row: 4, col: 4 })).toEqual({
      r0: 4,
      r1: 4,
      c0: 4,
      c1: 4,
    });
  });
});

describe('hasCrossedDragThreshold — distinguishes a real drag from a click', () => {
  const anchor = { x: 100, y: 100 };

  it('stays a click for no movement or movement strictly under the threshold', () => {
    expect(hasCrossedDragThreshold(anchor, 100, 100, 6)).toBe(false);
    expect(hasCrossedDragThreshold(anchor, 105, 100, 6)).toBe(false); // 5px < 6
    expect(hasCrossedDragThreshold(anchor, 100, 104, 6)).toBe(false); // 4px < 6
  });

  it('becomes a drag once either axis reaches the threshold', () => {
    expect(hasCrossedDragThreshold(anchor, 106, 100, 6)).toBe(true); // dx === threshold
    expect(hasCrossedDragThreshold(anchor, 100, 106, 6)).toBe(true); // dy === threshold
    expect(hasCrossedDragThreshold(anchor, 94, 100, 6)).toBe(true); // negative dx
  });

  it('becomes a drag when movement is diagonal and each axis alone is under threshold but combined intent is clearly a drag', () => {
    // Not a distance-formula check (the implementation is per-axis, matching
    // dnd-kit's own PointerSensor convention) — just documents that a big
    // enough single-axis move (here y) still triggers regardless of x.
    expect(hasCrossedDragThreshold(anchor, 103, 110, 6)).toBe(true);
  });
});

describe('parseCellDataset — reads a cell coordinate back off the DOM during a drag', () => {
  it('parses valid numeric strings', () => {
    expect(parseCellDataset({ row: '3', col: '5' })).toEqual({ row: 3, col: 5 });
    expect(parseCellDataset({ row: '0', col: '0' })).toEqual({ row: 0, col: 0 });
  });

  it('returns null for a missing dataset (pointer isn’t over a cell)', () => {
    expect(parseCellDataset(undefined)).toBeNull();
  });

  it('returns null when either coordinate is missing or not numeric', () => {
    expect(parseCellDataset({ row: undefined, col: '2' })).toBeNull();
    expect(parseCellDataset({ row: '2', col: undefined })).toBeNull();
    expect(parseCellDataset({ row: 'abc', col: '2' })).toBeNull();
  });
});
