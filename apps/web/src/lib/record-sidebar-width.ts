'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Draggable width for the record's properties sidebar (#198). The record layout
 * (`components/entity/record-detail.tsx`) is a body (`flex-1`) beside a fixed
 * `lg:w-72` aside; this makes that width a resizable, per-device preference so
 * you can give more room to whichever side you're working in.
 *
 * The width applies only at `lg`+ (the divider is `lg:block`); below that the
 * aside stays full-width stacked, so this value is inert on mobile.
 *
 * `clampSidebarWidth` is a pure helper (unit-tested) so the drag/keyboard math
 * lives in one place: it keeps the sidebar within [MIN, MAX] and, when the
 * container width is known, never lets the body shrink below MIN_BODY.
 */
export const SIDEBAR_DEFAULT_W = 288; // = Tailwind w-72, the pre-#198 fixed width
export const SIDEBAR_MIN_W = 220;
export const SIDEBAR_MAX_W = 520;
export const SIDEBAR_MIN_BODY_W = 360; // body never narrower than this
export const SIDEBAR_STEP = 16; // keyboard-arrow nudge, in px
export const SIDEBAR_WIDTH_KEY = 'storyos:record-sidebar-w';

/**
 * Clamp a desired sidebar width into the allowed range. When `containerWidth`
 * is supplied, the upper bound also reserves `SIDEBAR_MIN_BODY_W` for the body
 * (so a narrow window can't drag the body away). The floor (`SIDEBAR_MIN_W`)
 * always wins if the container is too small to honour both.
 */
export function clampSidebarWidth(width: number, containerWidth?: number): number {
  let max = SIDEBAR_MAX_W;
  if (containerWidth && Number.isFinite(containerWidth)) {
    const bodyBudget = containerWidth - SIDEBAR_MIN_BODY_W;
    if (bodyBudget < max) max = bodyBudget;
  }
  if (max < SIDEBAR_MIN_W) max = SIDEBAR_MIN_W;
  const rounded = Math.round(Number.isFinite(width) ? width : SIDEBAR_DEFAULT_W);
  return Math.min(max, Math.max(SIDEBAR_MIN_W, rounded));
}

/**
 * Sidebar-width state, restored from localStorage on mount (guarded for SSR, so
 * server and first client render agree on the default — the same tradeoff every
 * other localStorage-backed toggle in this app makes). `setWidth` updates state
 * only (used live during a drag, no I/O per pointermove); `persist` also writes
 * localStorage (used on drag end, keyboard nudge, and reset).
 */
export function useRecordSidebarWidth() {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_W);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw == null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setWidth(clampSidebarWidth(parsed));
  }, []);

  const persist = useCallback((next: number) => {
    setWidth(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    }
  }, []);

  return { width, setWidth, persist };
}
