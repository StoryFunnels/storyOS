import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_BODY_W,
  SIDEBAR_MIN_W,
} from './record-sidebar-width';

describe('clampSidebarWidth', () => {
  it('leaves an in-range width untouched (rounded)', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('clamps to the min and max bounds', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_W);
  });

  it('reserves min body width when a container width is given', () => {
    // container 1000 → body budget 1000 - 360 = 640, above MAX so MAX wins.
    expect(clampSidebarWidth(9999, 1000)).toBe(SIDEBAR_MAX_W);
    // container 700 → body budget 700 - 360 = 340, so the sidebar caps at 340.
    expect(clampSidebarWidth(9999, 700)).toBe(700 - SIDEBAR_MIN_BODY_W);
  });

  it('never drops below the min even in a tiny container', () => {
    // container 400 → body budget 40 < MIN, so the floor wins.
    expect(clampSidebarWidth(9999, 400)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(10, 400)).toBe(SIDEBAR_MIN_W);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_W);
  });
});
