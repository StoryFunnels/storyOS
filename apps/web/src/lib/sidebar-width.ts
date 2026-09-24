'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Draggable width for the main nav sidebar (`components/sidebar.tsx`, ticket
 * #742). The sidebar was a fixed `w-60` (240px) with no resize at all; the
 * design artifact's range (220–460px) is wide enough that dragging it out
 * stops long space names truncating — a real argument for a bigger default
 * than the artifact's own 284, which is why that number is kept as a default
 * rather than a floor.
 *
 * Deliberately simpler than `record-sidebar-width.ts`: that hook reserves a
 * minimum BODY width against its own measured flex container, because a
 * record's body can get genuinely narrow in a split pane. The main sidebar
 * sits beside the whole app's content area, which is never that constrained,
 * so this only clamps to [MIN, MAX] — no container-width reservation.
 */
export const SIDEBAR_NAV_DEFAULT_W = 284;
export const SIDEBAR_NAV_MIN_W = 220;
export const SIDEBAR_NAV_MAX_W = 460;
export const SIDEBAR_NAV_STEP = 16; // keyboard-arrow nudge, in px
export const SIDEBAR_NAV_WIDTH_KEY = 'storyos:nav-sidebar-w';

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
