import { describe, expect, it } from 'vitest';
import {
  clampSidebarNavWidth,
  SIDEBAR_NAV_DEFAULT_W,
  SIDEBAR_NAV_MAX_W,
  SIDEBAR_NAV_MIN_W,
  SIDEBAR_RAIL_W,
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

/**
 * #805 — 284 is the artifact's TOTAL sidebar width (rail + panel). It was built
 * as the PANEL width, making the sidebar 52px wider than designed everywhere.
 * The panel is what is left after the rail.
 */
describe('sidebar widths are TOTALS, rail included (#805)', () => {
  it('the default total is the artifact\'s 284, which leaves a 232px panel', () => {
    expect(SIDEBAR_NAV_DEFAULT_W).toBe(284);
    expect(SIDEBAR_RAIL_W).toBe(52);
    expect(SIDEBAR_NAV_DEFAULT_W - SIDEBAR_RAIL_W).toBe(232);
  });

  it('even the narrowest allowed total leaves the panel room to be a sidebar', () => {
    expect(SIDEBAR_NAV_MIN_W - SIDEBAR_RAIL_W).toBeGreaterThan(150);
  });
});
