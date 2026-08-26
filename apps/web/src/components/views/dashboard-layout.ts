import type { BlockLayout } from '@storyos/schemas';

/**
 * Structural, not the schema types.
 *
 * `dashboard-view.tsx` and `dashboard-widgets.tsx` each declare their OWN
 * `DashboardTile`/`DashboardWidget` interfaces that mirror the zod schemas
 * rather than importing them. That duplication predates this file and is not
 * worth unpicking here — but taking a hard dependency on either copy would make
 * this module pick a side and break against the other. All it actually needs is
 * an id and an optional layout, so that is all it asks for.
 */
export interface LayoutableBlock {
  id: string;
  layout?: BlockLayout;
}

/**
 * Dashboard layout (#386) — turning two stored arrays into ONE ordered grid.
 *
 * Kept as pure functions, separate from the component, for the same reason
 * `dashboard-tiles.ts` and `dashboard-charts.ts` are: the ordering and
 * backward-compatibility rules are the part that has to be right, and they are
 * provable without rendering anything.
 */

export const GRID_COLUMNS = 12;

/** A tile is 3 of 12 (a quarter) and one row tall — today's `minmax(220px, 1fr)`. */
export const DEFAULT_TILE_LAYOUT: Omit<BlockLayout, 'order'> = { w: 3, h: 1 };
/** A chart is 6 of 12 (a half) and two rows tall — today's 320px, with room to read. */
export const DEFAULT_WIDGET_LAYOUT: Omit<BlockLayout, 'order'> = { w: 6, h: 2 };

export type BlockKind = 'tile' | 'widget';

/** One thing on the grid, whichever array it came from. */
export interface DashboardBlock<T extends LayoutableBlock = LayoutableBlock, W extends LayoutableBlock = LayoutableBlock> {
  kind: BlockKind;
  id: string;
  layout: BlockLayout;
  tile?: T;
  widget?: W;
}

/**
 * Merge tiles and widgets into the single sequence the grid renders.
 *
 * **The backward-compatibility rule lives here.** A block with no stored
 * `layout` is not broken and is not migrated: it is given the default size and
 * an order derived from where it already sat — all tiles, then all widgets, each
 * in array order. That is precisely the pre-#386 rendering, so a dashboard
 * nobody has arranged comes out unchanged.
 *
 * A dashboard where only SOME blocks have been arranged is the case worth being
 * careful about, and it is why the fallback order is a real number rather than a
 * sort-to-the-end sentinel: mixed layouts have to interleave predictably, not
 * pile the untouched ones at the bottom.
 */
export function mergeBlocks<T extends LayoutableBlock, W extends LayoutableBlock>(
  tiles: readonly T[],
  widgets: readonly W[],
): DashboardBlock<T, W>[] {
  const blocks: DashboardBlock<T, W>[] = [
    ...tiles.map((tile, i) => ({
      kind: 'tile' as const,
      id: tile.id,
      layout: tile.layout ?? { order: i, ...DEFAULT_TILE_LAYOUT },
      tile,
    })),
    ...widgets.map((widget, i) => ({
      kind: 'widget' as const,
      id: widget.id,
      // Offset by tiles.length so an unarranged widget lands AFTER the tiles,
      // which is exactly where it rendered before #386.
      layout: widget.layout ?? { order: tiles.length + i, ...DEFAULT_WIDGET_LAYOUT },
      widget,
    })),
  ];
  /*
   * A stable sort by order alone. `Array.prototype.sort` is required to be
   * stable, so equal orders keep tiles-then-widgets — which is what makes the
   * fallback above deterministic rather than merely usually-right.
   */
  return blocks.sort((a, b) => a.layout.order - b.layout.order);
}

/**
 * Move the block at `from` to sit at `to`, and renumber.
 *
 * Renumbering the WHOLE sequence 0..n-1 on every move is deliberate. Sparse or
 * duplicated orders accumulate otherwise, and the first time two blocks share an
 * order the arrangement starts depending on array position — which is the bug
 * this module exists to remove.
 */
export function reorderBlocks<T extends LayoutableBlock, W extends LayoutableBlock>(
  blocks: readonly DashboardBlock<T, W>[],
  from: number,
  to: number,
): DashboardBlock<T, W>[] {
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) {
    return blocks.map((b, i) => ({ ...b, layout: { ...b.layout, order: i } }));
  }
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.map((b, i) => ({ ...b, layout: { ...b.layout, order: i } }));
}

/** Clamp a resize to the grid. A block wider than the grid cannot be laid out. */
export function clampSpan(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.min(GRID_COLUMNS, Math.max(1, Math.round(w))),
    h: Math.min(6, Math.max(1, Math.round(h))),
  };
}

/**
 * Split a merged, reordered sequence back into the two arrays that get stored.
 *
 * The two-array shape is kept on purpose (see `blockLayoutSchema`): merging them
 * into one list would be a config migration, and the thing users actually wanted
 * — a chart beside a tile — is delivered by the merged RENDER, not by merged
 * storage.
 */
export function splitBlocks<T extends LayoutableBlock, W extends LayoutableBlock>(
  blocks: readonly DashboardBlock<T, W>[],
): { tiles: T[]; widgets: W[] } {
  const tiles: T[] = [];
  const widgets: W[] = [];
  for (const b of blocks) {
    if (b.kind === 'tile' && b.tile) tiles.push({ ...b.tile, layout: b.layout });
    if (b.kind === 'widget' && b.widget) widgets.push({ ...b.widget, layout: b.layout });
  }
  return { tiles, widgets };
}

/**
 * The span for one block, as CSS custom properties.
 *
 * Deliberately NOT `gridColumn: "span N"` directly. An inline grid-column would
 * win over any media query, and the narrow-screen rule has to be able to
 * override it — `.dashboard-grid` in globals.css collapses every block to one
 * column below `md`.
 *
 * That indirection exists because of a CSS Grid behaviour worth stating: a child
 * spanning 6 inside a ONE-column grid does not clamp to one column, it creates
 * five IMPLICIT columns. So simply switching the parent to `grid-cols-1` does
 * not collapse anything, and a phone still gets tiles side by side.
 *
 * No explicit column START anywhere — flow placement is what makes overlap
 * unrepresentable.
 */
export function blockStyle(layout: BlockLayout): React.CSSProperties {
  return {
    '--block-w': Math.min(GRID_COLUMNS, layout.w),
    '--block-h': layout.h,
  } as React.CSSProperties;
}
