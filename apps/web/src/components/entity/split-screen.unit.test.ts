import { describe, expect, it } from 'vitest';
import {
  PRIMARY_ID,
  emptySplitStack,
  hasOpenElsewhereModifier,
  reduceSplit,
  selectSplitView,
  shouldOpenInSplit,
  type SplitStackState,
  type SplitTarget,
} from './split-screen';

describe('#146 split-screen — shouldOpenInSplit (mobile-fallback rule)', () => {
  const base = { hasSplitContext: true, isDesktop: true };

  it('opens the split for a plain primary click on desktop within a split context', () => {
    expect(shouldOpenInSplit({ ...base })).toBe(true);
  });

  it('falls back to navigation below the md breakpoint (mobile)', () => {
    expect(shouldOpenInSplit({ ...base, isDesktop: false })).toBe(false);
  });

  it('falls back to navigation when there is no split context (e.g. a table view)', () => {
    expect(shouldOpenInSplit({ ...base, hasSplitContext: false })).toBe(false);
  });

  it('lets modifier clicks through so cmd/ctrl-click still opens a new tab', () => {
    expect(shouldOpenInSplit({ ...base, modifierKey: true })).toBe(false);
  });

  it('lets non-primary (middle/right) clicks through', () => {
    expect(shouldOpenInSplit({ ...base, button: 1 })).toBe(false);
  });
});

describe('#146 split-screen — hasOpenElsewhereModifier', () => {
  it('is false for a bare click', () => {
    expect(hasOpenElsewhereModifier({})).toBe(false);
  });

  it('is true for each open-elsewhere modifier', () => {
    expect(hasOpenElsewhereModifier({ metaKey: true })).toBe(true);
    expect(hasOpenElsewhereModifier({ ctrlKey: true })).toBe(true);
    expect(hasOpenElsewhereModifier({ shiftKey: true })).toBe(true);
    expect(hasOpenElsewhereModifier({ altKey: true })).toBe(true);
  });
});

describe('#166/#167/#168 split-screen — reduceSplit (open / push / stack)', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const b: SplitTarget = { db: 'db-b', rec: 'beta-2', title: 'Beta' };
  const c: SplitTarget = { db: 'db-c', rec: 'gamma-3', title: 'Gamma' };

  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('starts empty (primary shown, nothing collapsed)', () => {
    const s = emptySplitStack();
    expect(s.panels).toEqual([]);
    expect(s.maximizedId).toBeNull();
    expect(s.primaryCollapsed).toBe(false);
  });

  it('open pushes a first, expanded panel on the right that becomes the active pane', () => {
    const s = open(emptySplitStack(), a);
    expect(s.panels).toHaveLength(1);
    expect(s.panels[0]!.collapsed).toBe(false);
    expect(s.panels[0]!.side).toBe('right');
    expect(s.panels[0]!.target).toEqual(a);
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a);
    expect(view.rightRailPanels).toEqual([]);
    expect(view.primaryOnRail).toBe(false);
  });

  it('mints a unique, stable id per open', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    const [p1, p2] = s.panels;
    expect(p1!.id).not.toEqual(p2!.id);
  });

  it('a second open PUSHES and docks the oldest expanded panel to the RIGHT rail (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    expect(s.panels).toHaveLength(2);
    expect(s.panels[0]!.collapsed).toBe(true); // oldest docked
    expect(s.panels[1]!.collapsed).toBe(false); // newest active
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b);
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a]); // rails right, not left
    expect(view.leftRailPanels).toEqual([]);
  });

  it('the right rail accumulates across further opens, each still present (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    s = open(s, c);
    expect(s.panels).toHaveLength(3);
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(c);
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a, b]);
  });

  it('re-opening the record that is already active is a no-op (guards double clicks)', () => {
    const s = open(emptySplitStack(), a);
    expect(open(s, a)).toBe(s);
  });

  it('expanding a rail docks the current pane, keeping the active pair (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a → rail, b active
    const railId = s.panels[0]!.id; // a
    s = reduceSplit(s, { type: 'expand', id: railId });
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a); // a swapped back in
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([b]); // b now on the rail
  });

  it('reset drops the whole stack (mobile fallback)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    s = reduceSplit(s, { type: 'reset' });
    expect(s).toEqual(emptySplitStack());
  });

  it('ignores control actions for unknown panel ids (no corruption)', () => {
    const s = open(emptySplitStack(), a);
    expect(reduceSplit(s, { type: 'collapse', id: 'nope' })).toBe(s);
    expect(reduceSplit(s, { type: 'expand', id: 'nope' })).toBe(s);
    expect(reduceSplit(s, { type: 'maximize', id: 'nope' })).toBe(s);
    expect(reduceSplit(s, { type: 'close', id: 'nope' })).toBe(s);
  });
});

describe('#182 split-screen — symmetric collapse-in-place', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('collapsing a right panel docks it to the RIGHT rail (in place, no jump)', () => {
    const opened = open(emptySplitStack(), a);
    const id = opened.panels[0]!.id;
    const collapsed = reduceSplit(opened, { type: 'collapse', id });
    expect(collapsed.panels[0]!.collapsed).toBe(true);
    const view = selectSplitView(collapsed);
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a]);
    expect(view.leftRailPanels).toEqual([]);
    expect(view.activePanel).toBeNull(); // only the primary pane + the right rail
  });

  it('collapse → expand round-trips a panel back to the active pane (#166)', () => {
    const opened = open(emptySplitStack(), a);
    const id = opened.panels[0]!.id;
    const collapsed = reduceSplit(opened, { type: 'collapse', id });
    const expanded = reduceSplit(collapsed, { type: 'expand', id });
    expect(expanded.panels[0]!.collapsed).toBe(false);
    expect(selectSplitView(expanded).activePanel?.target).toEqual(a);
  });
});

describe('#183 split-screen — primary is a collapsible pane', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('collapsing the primary docks it to the LEFT rail, independent of any maximize', () => {
    let s = open(emptySplitStack(), a); // primary pane + panel a active
    s = reduceSplit(s, { type: 'collapse', id: PRIMARY_ID });
    expect(s.primaryCollapsed).toBe(true);
    const view = selectSplitView(s);
    expect(view.primaryOnRail).toBe(true); // primary now a left rail
    expect(view.primaryMaximized).toBe(false);
    expect(view.activePanel?.target).toEqual(a); // panel a still the pane
  });

  it('expanding the primary brings it back as a pane', () => {
    let s = open(emptySplitStack(), a);
    s = reduceSplit(s, { type: 'collapse', id: PRIMARY_ID });
    s = reduceSplit(s, { type: 'expand', id: PRIMARY_ID });
    expect(s.primaryCollapsed).toBe(false);
    expect(selectSplitView(s).primaryOnRail).toBe(false);
  });

  it('collapsing the primary when already collapsed is a no-op', () => {
    let s = open(emptySplitStack(), a);
    s = reduceSplit(s, { type: 'collapse', id: PRIMARY_ID });
    expect(reduceSplit(s, { type: 'collapse', id: PRIMARY_ID })).toBe(s);
  });
});

describe('#167/#182 split-screen — maximize / restore from either side', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const b: SplitTarget = { db: 'db-b', rec: 'beta-2', title: 'Beta' };
  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('maximizing a panel fills the area, docks siblings, and rails the primary (#167)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    const bId = s.panels[1]!.id;
    s = reduceSplit(s, { type: 'maximize', id: bId });
    expect(s.maximizedId).toBe(bId);
    const view = selectSplitView(s);
    expect(view.activePanelMaximized).toBe(true);
    expect(view.primaryOnRail).toBe(true); // primary pushed to its left rail
    expect(view.activePanel?.target).toEqual(b);
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a]);
  });

  it('maximizing the primary fills the area and docks every panel to the right rail (#182)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    s = reduceSplit(s, { type: 'maximize', id: PRIMARY_ID });
    expect(s.maximizedId).toBe(PRIMARY_ID);
    expect(s.panels.every((p) => p.collapsed)).toBe(true);
    const view = selectSplitView(s);
    expect(view.primaryMaximized).toBe(true);
    expect(view.primaryOnRail).toBe(false);
    expect(view.activePanel).toBeNull();
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a, b]);
  });

  it('restore leaves a panel-maximize and brings the primary pane back as the pair (#167)', () => {
    let s = open(emptySplitStack(), a);
    const id = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'maximize', id });
    s = reduceSplit(s, { type: 'restore' });
    expect(s.maximizedId).toBeNull();
    const view = selectSplitView(s);
    expect(view.activePanelMaximized).toBe(false);
    expect(view.primaryOnRail).toBe(false); // primary pane returns
    expect(view.activePanel?.target).toEqual(a);
  });

  it('restore clears a primary-maximize', () => {
    let s = open(emptySplitStack(), a);
    s = reduceSplit(s, { type: 'maximize', id: PRIMARY_ID });
    s = reduceSplit(s, { type: 'restore' });
    expect(s.maximizedId).toBeNull();
    expect(selectSplitView(s).primaryMaximized).toBe(false);
  });

  it('expanding a rail panel steps a maximized primary back down to the pair', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    s = reduceSplit(s, { type: 'maximize', id: PRIMARY_ID }); // primary fills, a & b railed
    const bId = s.panels.find((p) => p.target === b)!.id;
    s = reduceSplit(s, { type: 'expand', id: bId });
    expect(s.maximizedId).toBeNull();
    const view = selectSplitView(s);
    expect(view.primaryMaximized).toBe(false);
    expect(view.primaryOnRail).toBe(false);
    expect(view.activePanel?.target).toEqual(b);
  });
});

describe('#168/#184 split-screen — close (panels and from the rail)', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const b: SplitTarget = { db: 'db-b', rec: 'beta-2', title: 'Beta' };
  const c: SplitTarget = { db: 'db-c', rec: 'gamma-3', title: 'Gamma' };
  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('closing the active pane unwinds by popping the most-recent rail (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    s = open(s, c); // rails: a, b ; active: c
    const cId = s.panels[2]!.id;
    s = reduceSplit(s, { type: 'close', id: cId });
    let view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b); // b popped back in
    expect(view.rightRailPanels.map((p) => p.target)).toEqual([a]);

    const bId = s.panels.find((p) => p.target === b)!.id;
    s = reduceSplit(s, { type: 'close', id: bId });
    view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a); // a popped back in
    expect(view.rightRailPanels).toEqual([]);

    const aId = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'close', id: aId });
    expect(s.panels).toEqual([]); // fully unwound to the primary-only view
  });

  it('closing a rail panel (the X on the rail #184) leaves the active pane untouched', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    const aId = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'close', id: aId });
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b);
    expect(view.rightRailPanels).toEqual([]);
  });

  it('closing a maximized panel clears the maximize and unwinds', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    const bId = s.panels[1]!.id;
    s = reduceSplit(s, { type: 'maximize', id: bId });
    s = reduceSplit(s, { type: 'close', id: bId });
    expect(s.maximizedId).toBeNull();
    expect(selectSplitView(s).activePanel?.target).toEqual(a);
  });

  it('closing the last panel resets primaryCollapsed back to the plain view', () => {
    let s = open(emptySplitStack(), a);
    s = reduceSplit(s, { type: 'collapse', id: PRIMARY_ID }); // primary railed
    const aId = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'close', id: aId });
    expect(s.panels).toEqual([]);
    expect(s.primaryCollapsed).toBe(false); // primary comes back full-page
  });

  it('closing the primary from its rail (#184) restores it — it is never removed', () => {
    let s = open(emptySplitStack(), a);
    s = reduceSplit(s, { type: 'collapse', id: PRIMARY_ID }); // primary railed
    s = reduceSplit(s, { type: 'close', id: PRIMARY_ID });
    expect(s.primaryCollapsed).toBe(false);
    expect(s.panels).toHaveLength(1); // panel a still there
    expect(selectSplitView(s).primaryOnRail).toBe(false);
  });

  it('closing the primary when it is a pane (nothing to restore) is a no-op', () => {
    const s = open(emptySplitStack(), a);
    expect(reduceSplit(s, { type: 'close', id: PRIMARY_ID })).toBe(s);
  });
});
