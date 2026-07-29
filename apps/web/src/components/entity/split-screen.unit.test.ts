import { describe, expect, it } from 'vitest';
import {
  hasOpenElsewhereModifier,
  reduceSplit,
  shouldOpenInSplit,
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

describe('#146 split-screen — reduceSplit (single-panel, no stacking)', () => {
  const a: SplitTarget = { db: 'db-a', rec: 'alpha-1' };
  const b: SplitTarget = { db: 'db-b', rec: 'beta-2' };

  it('opens a panel from the base (null) state', () => {
    expect(reduceSplit(null, { type: 'open', target: a })).toEqual(a);
  });

  it('REPLACES the current target on a second open (drills, never stacks)', () => {
    const first = reduceSplit(null, { type: 'open', target: a });
    expect(reduceSplit(first, { type: 'open', target: b })).toEqual(b);
  });

  it('closes back to the base view', () => {
    expect(reduceSplit(a, { type: 'close' })).toBeNull();
  });
});
