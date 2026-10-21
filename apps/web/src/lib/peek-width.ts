'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * #996 — the width of the record PEEK: a record opened beside a view.
 *
 * Before this, a record opened from a view took the split host's shared ratio (50/50 by default), so on a wide
 * screen the pane was far wider than the record's content and the view was squeezed to what was left. The rule is
 * the other way round: the record pane is a PIXEL width sized to the record layout (the prototype's `.recwrap` is
 * 720 wide), the person can drag it, the choice is remembered per viewer, and the view keeps ALL the remaining width.
 *
 * The record-beside-a-record pair keeps its own ratio (`split-pane-ratio.ts`); this is only for a list primary.
 * The clamp lives here, pure and unit-tested, so the drag path, the keyboard path and the first render cannot
 * disagree about the limits.
 */
export const PEEK_WIDTH_DEFAULT = 680;
export const PEEK_WIDTH_MIN = 420;
export const PEEK_WIDTH_MAX = 960;
/** The view keeps at least this much width beside the peek, whatever was stored. */
export const PEEK_VIEW_MIN = 300;
export const PEEK_WIDTH_STEP = 24;
export const PEEK_WIDTH_KEY = 'storyos:peek-width';

/**
 * Clamp a wanted peek width to what the container can give. `containerWidth` is the row that holds the view and
 * the peek; 0 / unknown (not measured yet) leaves only the absolute limits, so the first paint is not wrong.
 * On a container too narrow for both, the view still gets its minimum and the peek shrinks toward ITS minimum,
 * never below it — a record you cannot read is worse than a view you cannot see.
 */
export function clampPeekWidth(width: number, containerWidth: number): number {
  const wanted = Number.isFinite(width) ? width : PEEK_WIDTH_DEFAULT;
  const room = containerWidth > 0 ? containerWidth - PEEK_VIEW_MIN : PEEK_WIDTH_MAX;
  const upper = Math.max(PEEK_WIDTH_MIN, Math.min(PEEK_WIDTH_MAX, room));
  return Math.round(Math.min(upper, Math.max(PEEK_WIDTH_MIN, wanted)));
}

/** The peek's width for a divider dragged to `clientX`, given the container's right edge (the peek is on the right). */
export function peekWidthFromPointer(clientX: number, regionRight: number, containerWidth: number): number {
  return clampPeekWidth(regionRight - clientX, containerWidth);
}

/**
 * The remembered peek width, restored from localStorage on mount (SSR-guarded so server and first client render
 * agree on the default). `setWidth` updates state only (live during a drag, no I/O per pointermove); `persist`
 * also writes the key (drag end, keyboard nudge, reset). Never throws when storage is blocked.
 */
export function usePeekWidth() {
  const [width, setWidth] = useState(PEEK_WIDTH_DEFAULT);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PEEK_WIDTH_KEY);
      if (raw == null) return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) setWidth(clampPeekWidth(parsed, 0));
    } catch {
      /* storage blocked: the default stands */
    }
  }, []);

  const persist = useCallback((next: number) => {
    const clamped = clampPeekWidth(next, 0);
    setWidth(clamped);
    try {
      window.localStorage.setItem(PEEK_WIDTH_KEY, String(clamped));
    } catch {
      /* storage blocked: the width still applies for this session */
    }
  }, []);

  return { width, setWidth, persist };
}
