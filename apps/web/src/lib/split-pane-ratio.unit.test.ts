import { describe, expect, it } from 'vitest';
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  clampSplitRatio,
  ratioFromPointer,
} from './split-pane-ratio';

describe('#208 split-pane ratio — clampSplitRatio', () => {
  it('keeps a mid-band ratio unchanged', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.4)).toBe(0.4);
  });

  it('clamps below MIN and above MAX so neither pane collapses', () => {
    expect(clampSplitRatio(0.05)).toBe(SPLIT_RATIO_MIN);
    expect(clampSplitRatio(0.95)).toBe(SPLIT_RATIO_MAX);
    expect(clampSplitRatio(-3)).toBe(SPLIT_RATIO_MIN);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSplitRatio(NaN)).toBe(SPLIT_RATIO_DEFAULT);
    expect(clampSplitRatio(Infinity)).toBe(SPLIT_RATIO_DEFAULT);
  });
});

describe('#208 split-pane ratio — ratioFromPointer', () => {
  it('maps a pointer at the region midpoint to ~0.5', () => {
    expect(ratioFromPointer(500, 0, 1000)).toBe(0.5);
  });

  it('accounts for the region left offset (e.g. a left rail before the pair)', () => {
    // region starts at x=200, width 800; pointer at 600 → (600-200)/800 = 0.5
    expect(ratioFromPointer(600, 200, 800)).toBe(0.5);
  });

  it('clamps a pointer dragged past either edge into the band', () => {
    expect(ratioFromPointer(10, 0, 1000)).toBe(SPLIT_RATIO_MIN);
    expect(ratioFromPointer(990, 0, 1000)).toBe(SPLIT_RATIO_MAX);
  });

  it('falls back to the default when the region has no measured width', () => {
    expect(ratioFromPointer(600, 0, 0)).toBe(SPLIT_RATIO_DEFAULT);
  });
});
