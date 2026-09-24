import { describe, expect, it } from 'vitest';
import { SIDEBAR_INDENT_PX, sidebarRowIndent, sidebarRowStateClass } from './sidebar-row-style';

/**
 * #380 / #742 — this geometry has regressed twice under the OLD margin-scale
 * model, so its replacement is pinned too.
 *
 * #219 fixed the document row by copying an invisible grip spacer out of
 * DatabaseRow. #347 then added view rows, which never inherited that copy, and a
 * space-level dashboard rendered ~10px LEFT of the databases beside it.
 *
 * #742 REPLACES the three-level margin scale with the design artifact's
 * fixed-icon-gutter model: a space's label and a database's label now start
 * at the SAME x (findings 02/12 — "four levels, zero indent steps"), and the
 * only real indent left is a folder's own children (one step). These
 * assertions changed deliberately along with the model, not as a drift — the
 * invariant they protect is still "one row type cannot silently disagree
 * with its siblings about where it starts."
 */
describe('sidebar row geometry (#380, model replaced by #742)', () => {
  it('every row directly in a space shares ONE edge — including the space header itself', () => {
    // Depth 0 is now "not inside a folder", not "is a space" — a space header,
    // a database, a folder row, a space-level view/dashboard/document all
    // share it. This is the #742 redesign's core claim: labels no longer step
    // right as you go deeper, alignment comes from the icon column instead.
    expect(sidebarRowIndent(0)).toBe(0);
    expect(sidebarRowIndent(0)).toBe(SIDEBAR_INDENT_PX[0]);
  });

  it('a folder\'s own children get the ONE real indent step in the tree', () => {
    // A folder genuinely CONTAINS its rows rather than merely preceding them
    // — the one case an indent states a fact instead of decorating one.
    expect(sidebarRowIndent(1)).toBeGreaterThan(sidebarRowIndent(0));
    expect(sidebarRowIndent(1)).toBe(SIDEBAR_INDENT_PX[1]);
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
