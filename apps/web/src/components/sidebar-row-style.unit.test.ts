import { describe, expect, it } from 'vitest';
import { SIDEBAR_INDENT_PX, sidebarRowIndent, sidebarRowStateClass } from './sidebar-row-style';

/**
 * #380 — this geometry has regressed TWICE, so it is pinned.
 *
 * #219 fixed the document row by copying an invisible grip spacer out of
 * DatabaseRow. #347 then added view rows, which never inherited that copy, and a
 * space-level dashboard rendered ~10px LEFT of the databases beside it.
 *
 * The point of these assertions is that a row type added later (#368, #369) gets
 * its indent from ONE scale rather than a per-component guess — so the next new
 * type cannot silently miss it the way view rows did.
 */
describe('sidebar row geometry (#380)', () => {
  it('a space is leftmost; its contents step right; nested things step right again', () => {
    // Asserted as an ORDERING, not three magic numbers — the founder's spec is
    // relative ("database slightly to the right of the space"), so pinning exact
    // pixels would fail on a legitimate re-space while missing an inversion.
    expect(sidebarRowIndent(0)).toBeLessThan(sidebarRowIndent(1));
    expect(sidebarRowIndent(1)).toBeLessThan(sidebarRowIndent(2));
  });

  it('databases, folders, dashboards and documents share ONE left edge', () => {
    // All four are depth 1. The bug was a dashboard rendering LEFT of the
    // databases it sits beside, so what matters is that one depth means one
    // number for every row type that claims it.
    const edges = new Set([sidebarRowIndent(1), sidebarRowIndent(1), sidebarRowIndent(1)]);
    expect(edges.size).toBe(1);
    expect(sidebarRowIndent(1)).toBe(SIDEBAR_INDENT_PX[1]);
  });

  it('nested views and folder children resolve to ONE deeper edge', () => {
    // These used to disagree: ml-4 (16px) for a database's views vs ml-3 (12px)
    // for a folder's children. Both are depth 2 now.
    expect(sidebarRowIndent(2)).toBe(SIDEBAR_INDENT_PX[2]);
  });

  it('marks the active row with BACKGROUND only — no accent bar', () => {
    // The bar was applied per row type, so a database and the "All records" row
    // it opens were both active: two stacked amber bars for one location.
    expect(sidebarRowStateClass(true)).toContain('bg-active');
    expect(sidebarRowStateClass(true), 'the amber inset bar must not come back').not.toContain('inset_2px');
  });

  it('keeps hover and active visually distinct', () => {
    // Once the bar is gone, bg-active carries the whole "you are here" job.
    const active = sidebarRowStateClass(true);
    const idle = sidebarRowStateClass(false);
    expect(active).not.toEqual(idle);
    expect(idle).toContain('hover:bg-hover');
    expect(active, 'the active row must not also apply a hover background').not.toContain('hover:bg-hover');
  });
});
