import { describe, expect, it } from 'vitest';
import type { DashboardTile, DashboardWidget } from '@storyos/schemas';
import {
  clampSpan,
  DEFAULT_TILE_LAYOUT,
  DEFAULT_WIDGET_LAYOUT,
  GRID_COLUMNS,
  blockStyle,
  mergeBlocks,
  reorderBlocks,
  splitBlocks,
} from './dashboard-layout';

/**
 * #386 — the ordering and backward-compatibility rules.
 *
 * The single most important assertion in this file is the one about a dashboard
 * saved BEFORE #386: the ticket's constraint is "existing dashboards must render
 * unchanged", and that is a claim about ordering, not about pixels.
 */

const tile = (id: string, layout?: DashboardTile['layout']): DashboardTile =>
  ({ id, label: '', op: 'count', ...(layout ? { layout } : {}) }) as DashboardTile;
const widget = (id: string, layout?: DashboardWidget['layout']): DashboardWidget =>
  ({ id, type: 'bar', title: '', measure: { op: 'count' }, ...(layout ? { layout } : {}) }) as DashboardWidget;

describe('a dashboard saved before #386 renders exactly as it did', () => {
  it('puts every tile before every widget, each in array order', () => {
    const blocks = mergeBlocks([tile('t1'), tile('t2')], [widget('w1'), widget('w2')]);
    expect(blocks.map((b) => b.id)).toEqual(['t1', 't2', 'w1', 'w2']);
  });

  it('gives unarranged blocks the default size rather than nothing', () => {
    const [t, w] = mergeBlocks([tile('t1')], [widget('w1')]);
    expect(t!.layout).toMatchObject(DEFAULT_TILE_LAYOUT);
    expect(w!.layout).toMatchObject(DEFAULT_WIDGET_LAYOUT);
  });

  it('does NOT mutate the stored config — absent stays absent until someone arranges it', () => {
    // #305: unconfigured is not invalid. Merging must not be a silent migration.
    const tiles = [tile('t1')];
    mergeBlocks(tiles, []);
    expect(tiles[0]!.layout).toBeUndefined();
  });
});

describe('a partly-arranged dashboard interleaves predictably', () => {
  it('respects a stored order that moves a widget ABOVE the tiles', () => {
    /*
     * The case #386 is actually for: a chart beside — or before — the number it
     * explains. Before this, a widget could not precede a tile at all; the two
     * separate grids made it structurally impossible.
     */
    const blocks = mergeBlocks(
      [tile('t1', { order: 1, w: 3, h: 1 })],
      [widget('w1', { order: 0, w: 6, h: 2 })],
    );
    expect(blocks.map((b) => b.id)).toEqual(['w1', 't1']);
  });

  it('places an unarranged block by where it already sat, not at the end', () => {
    // t2 has no layout, so it falls back to index 1 and lands between the two
    // arranged blocks. Sorting untouched blocks to the bottom instead would
    // rearrange a dashboard the moment someone dragged one single tile.
    const blocks = mergeBlocks(
      [tile('t1', { order: 0, w: 3, h: 1 }), tile('t2'), tile('t3', { order: 2, w: 3, h: 1 })],
      [],
    );
    expect(blocks.map((b) => b.id)).toEqual(['t1', 't2', 't3']);
  });

  it('breaks an order tie by tiles-then-widgets rather than arbitrarily', () => {
    const blocks = mergeBlocks(
      [tile('t1', { order: 0, w: 3, h: 1 })],
      [widget('w1', { order: 0, w: 6, h: 2 })],
    );
    expect(blocks.map((b) => b.id)).toEqual(['t1', 'w1']);
  });
});

describe('reordering', () => {
  const base = () => mergeBlocks([tile('t1'), tile('t2'), tile('t3')], [widget('w1')]);

  it('moves a block and renumbers the whole sequence contiguously', () => {
    const out = reorderBlocks(base(), 3, 0);
    expect(out.map((b) => b.id)).toEqual(['w1', 't1', 't2', 't3']);
    // Contiguous 0..n-1: sparse or duplicated orders are what make an
    // arrangement start depending on array position again.
    expect(out.map((b) => b.layout.order)).toEqual([0, 1, 2, 3]);
  });

  it('survives a round trip through storage', () => {
    const moved = reorderBlocks(base(), 3, 0);
    const { tiles, widgets } = splitBlocks(moved);
    expect(mergeBlocks(tiles, widgets).map((b) => b.id)).toEqual(['w1', 't1', 't2', 't3']);
  });

  it('keeps each block in its OWN array — the render merges, the storage does not', () => {
    const { tiles, widgets } = splitBlocks(reorderBlocks(base(), 3, 0));
    expect(tiles.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(widgets.map((w) => w.id)).toEqual(['w1']);
  });

  it('renumbers without moving anything when the indices are a no-op or out of range', () => {
    for (const [from, to] of [
      [1, 1],
      [-1, 2],
      [0, 99],
    ]) {
      const out = reorderBlocks(base(), from!, to!);
      expect(out.map((b) => b.id)).toEqual(['t1', 't2', 't3', 'w1']);
      expect(out.map((b) => b.layout.order)).toEqual([0, 1, 2, 3]);
    }
  });
});

describe('resizing is clamped to something renderable', () => {
  it('never exceeds the grid width', () => {
    expect(clampSpan(99, 1).w).toBe(GRID_COLUMNS);
  });

  it('never goes below one cell — a zero-width block would vanish', () => {
    expect(clampSpan(0, 0)).toEqual({ w: 1, h: 1 });
    expect(clampSpan(-5, -5)).toEqual({ w: 1, h: 1 });
  });

  it('rounds a fractional drag to a whole cell', () => {
    expect(clampSpan(3.4, 2.6)).toEqual({ w: 3, h: 3 });
  });
});

describe('blockStyle', () => {
  it('emits CSS VARIABLES, not grid-column — an inline span would beat the media query', () => {
    /*
     * The narrow-screen collapse lives in a media query on `.dashboard-grid`.
     * An inline `grid-column` has higher specificity than any stylesheet rule,
     * so emitting one here would make the phone layout unfixable.
     */
    expect(blockStyle({ order: 0, w: 4, h: 2 })).toEqual({ '--block-w': 4, '--block-h': 2 });
  });

  it('never emits an absolute column — flow placement is what forbids overlap', () => {
    const style = blockStyle({ order: 0, w: 4, h: 2 }) as Record<string, unknown>;
    expect(style.gridColumn).toBeUndefined();
    expect(style.gridColumnStart).toBeUndefined();
  });

  it('caps a stored width wider than the grid instead of blowing the row out', () => {
    expect((blockStyle({ order: 0, w: 99, h: 1 }) as Record<string, unknown>)['--block-w']).toBe(12);
  });
});
