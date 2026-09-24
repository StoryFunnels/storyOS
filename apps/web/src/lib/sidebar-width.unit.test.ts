import { describe, expect, it } from 'vitest';
import {
  clampSidebarNavWidth,
  SIDEBAR_NAV_DEFAULT_W,
  SIDEBAR_NAV_MAX_W,
  SIDEBAR_NAV_MIN_W,
} from './sidebar-width';

describe('clampSidebarNavWidth', () => {
  it('leaves an in-range width untouched (rounded)', () => {
    expect(clampSidebarNavWidth(300)).toBe(300);
    expect(clampSidebarNavWidth(300.6)).toBe(301);
  });

  it('clamps to the min and max bounds — 220 to 460, per the design spec', () => {
    expect(clampSidebarNavWidth(50)).toBe(SIDEBAR_NAV_MIN_W);
    expect(clampSidebarNavWidth(9999)).toBe(SIDEBAR_NAV_MAX_W);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarNavWidth(Number.NaN)).toBe(SIDEBAR_NAV_DEFAULT_W);
  });
});
