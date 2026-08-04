import { describe, expect, it } from 'vitest';
import {
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

describe('#166/#167/#168 split-screen — reduceSplit (panel stack)', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1', title: 'Alpha' };
  const b: SplitTarget = { db: 'db-b', rec: 'beta-2', title: 'Beta' };
  const c: SplitTarget = { db: 'db-c', rec: 'gamma-3', title: 'Gamma' };

  const open = (state: SplitStackState, target: SplitTarget) => reduceSplit(state, { type: 'open', target });

  it('starts empty', () => {
    const s = emptySplitStack();
    expect(s.panels).toEqual([]);
    expect(s.maximizedId).toBeNull();
  });

  it('open pushes a first, expanded panel that becomes the active pane', () => {
    const s = open(emptySplitStack(), a);
    expect(s.panels).toHaveLength(1);
    expect(s.panels[0]!.collapsed).toBe(false);
    expect(s.panels[0]!.target).toEqual(a);
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a);
    expect(view.railPanels).toEqual([]);
  });

  it('mints a unique, stable id per open', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    const [p1, p2] = s.panels;
    expect(p1!.id).not.toEqual(p2!.id);
  });

  it('a second open PUSHES and docks the oldest expanded panel to a rail (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    expect(s.panels).toHaveLength(2);
    // Oldest (a) docked, newest (b) is the active pane — the active pair is kept.
    expect(s.panels[0]!.collapsed).toBe(true);
    expect(s.panels[1]!.collapsed).toBe(false);
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b);
    expect(view.railPanels.map((p) => p.target)).toEqual([a]);
  });

  it('the rail accumulates across further opens, each still present (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    s = open(s, c);
    expect(s.panels).toHaveLength(3);
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(c);
    expect(view.railPanels.map((p) => p.target)).toEqual([a, b]);
  });

  it('re-opening the record that is already active is a no-op (guards double clicks)', () => {
    const s = open(emptySplitStack(), a);
    expect(open(s, a)).toBe(s);
  });

  it('collapse docks a panel to a rail; expand round-trips it back (#166)', () => {
    const opened = open(emptySplitStack(), a);
    const id = opened.panels[0]!.id;
    const collapsed = reduceSplit(opened, { type: 'collapse', id });
    expect(collapsed.panels[0]!.collapsed).toBe(true);
    expect(selectSplitView(collapsed).activePanel).toBeNull(); // only rails + primary
    const expanded = reduceSplit(collapsed, { type: 'expand', id });
    expect(expanded.panels[0]!.collapsed).toBe(false);
    expect(selectSplitView(expanded).activePanel?.target).toEqual(a);
  });

  it('expanding a rail docks the current pane, keeping the active pair (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a → rail, b active
    const railId = s.panels[0]!.id; // a
    s = reduceSplit(s, { type: 'expand', id: railId });
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a); // a swapped back in
    expect(view.railPanels.map((p) => p.target)).toEqual([b]); // b now on the rail
  });

  it('maximize fills the split area and docks every sibling (#167)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    const bId = s.panels[1]!.id;
    s = reduceSplit(s, { type: 'maximize', id: bId });
    expect(s.maximizedId).toBe(bId);
    expect(s.panels.every((p) => (p.id === bId ? !p.collapsed : p.collapsed))).toBe(true);
    const view = selectSplitView(s);
    expect(view.maximized).toBe(true);
    expect(view.activePanel?.target).toEqual(b);
  });

  it('restore returns to the shared pair (#167)', () => {
    let s = open(emptySplitStack(), a);
    const id = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'maximize', id });
    s = reduceSplit(s, { type: 'restore' });
    expect(s.maximizedId).toBeNull();
    expect(selectSplitView(s).maximized).toBe(false);
  });

  it('closing the active pane unwinds by popping the most-recent rail (#168)', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b);
    s = open(s, c); // rails: a, b ; active: c
    const cId = s.panels[2]!.id;
    s = reduceSplit(s, { type: 'close', id: cId });
    let view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b); // b popped back in
    expect(view.railPanels.map((p) => p.target)).toEqual([a]);

    const bId = s.panels.find((p) => p.target === b)!.id;
    s = reduceSplit(s, { type: 'close', id: bId });
    view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(a); // a popped back in
    expect(view.railPanels).toEqual([]);

    const aId = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'close', id: aId });
    expect(s.panels).toEqual([]); // fully unwound to the primary-only view
  });

  it('closing a rail leaves the active pane untouched', () => {
    let s = open(emptySplitStack(), a);
    s = open(s, b); // a rail, b active
    const aId = s.panels[0]!.id;
    s = reduceSplit(s, { type: 'close', id: aId });
    const view = selectSplitView(s);
    expect(view.activePanel?.target).toEqual(b);
    expect(view.railPanels).toEqual([]);
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
