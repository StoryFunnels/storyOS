'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Draggable width for the main nav sidebar (`components/sidebar.tsx`, ticket
 * #742). The sidebar was a fixed `w-60` (240px) with no resize at all; the
 * artifact's range is 220–460px (default now 304px total, see SIDEBAR_NAV_DEFAULT_W).
 *
 * The default width is NOT "the width at which nothing clips" — that question turned out
 * to be the wrong one. Ievgen's ruling (ticket #742, 2026-09-28, with Fibery
 * as the reference): truncation is acceptable, so the default is sized for
 * the common case, not the longest name in the workspace — resize is the
 * escape hatch for anyone who wants it, and labels hard-cut at the panel
 * edge rather than ellipsizing (also his call — "cutting symbols behind the
 * divider is acceptable").
 *
 * Deliberately simpler than `record-sidebar-width.ts`: that hook reserves a
 * minimum BODY width against its own measured flex container, because a
 * record's body can get genuinely narrow in a split pane. The main sidebar
 * sits beside the whole app's content area, which is never that constrained,
 * so this only clamps to [MIN, MAX] — no container-width reservation.
 */
/**
 * #805 — these are TOTAL widths, rail included, because that is what the
 * artifact's totals were (220/460, and the old 284 default): `.sb` (rail + panel) was 284 wide, rail 52 +
 * panel 231 + borders. They were built as the PANEL width, which made the
 * whole sidebar 52px wider than designed on every screen. The `<aside>` is
 * therefore `width - SIDEBAR_RAIL_W`.
 */
export const SIDEBAR_RAIL_W = 52;
/**
 * Fidelity audit (ticket #1273, item 1): the prototype's panel is 252px, measured at 1270 (rail 52 + panel 252 = 304 total).
 * The default was 284 (a 232px panel, 20px short), which truncated database and view names sooner than designed. 252 was
 * chosen together with the 12px/22px tree rows, so names fit. Only the DEFAULT moved: a width a person dragged to is stored
 * under SIDEBAR_NAV_WIDTH_KEY and still wins.
 */
export const SIDEBAR_NAV_DEFAULT_W = 304;
export const SIDEBAR_NAV_MIN_W = 220;
export const SIDEBAR_NAV_MAX_W = 460;
export const SIDEBAR_NAV_STEP = 16; // keyboard-arrow nudge, in px
// New key (was `storyos:nav-sidebar-w`, which stored a PANEL width): reading an
// old panel-width value as a total would silently shrink a user's dragged
// sidebar by 52px. Starting from the default once is the honest alternative.
export const SIDEBAR_NAV_WIDTH_KEY = 'storyos:nav-sidebar-total-w';

/** Clamp a desired sidebar width into [SIDEBAR_NAV_MIN_W, SIDEBAR_NAV_MAX_W]. */
export function clampSidebarNavWidth(width: number): number {
  const rounded = Math.round(Number.isFinite(width) ? width : SIDEBAR_NAV_DEFAULT_W);
  return Math.min(SIDEBAR_NAV_MAX_W, Math.max(SIDEBAR_NAV_MIN_W, rounded));
}

/**
 * Sidebar-width state, restored from localStorage on mount (SSR-guarded, so
 * server and first client render agree on the default). `setWidth` updates
 * state only (used live during a drag, no I/O per pointermove); `persist`
 * also writes localStorage (used on drag end, keyboard nudge, and reset).
 */
export function useSidebarNavWidth() {
  const [width, setWidth] = useState(SIDEBAR_NAV_DEFAULT_W);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(SIDEBAR_NAV_WIDTH_KEY);
    if (raw == null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setWidth(clampSidebarNavWidth(parsed));
  }, []);

  const persist = useCallback((next: number) => {
    setWidth(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_NAV_WIDTH_KEY, String(Math.round(next)));
    }
  }, []);

  return { width, setWidth, persist };
}
