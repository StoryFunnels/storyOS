'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Draggable width ratio for the two open split-screen panes (#208 — follow-up to
 * #198's record body↔sidebar divider). The split host (`split-screen-host.tsx`)
 * normally shows the primary record and one panel as a ~50/50 pair; this makes
 * that boundary draggable so you can favour whichever record you're focused on.
 *
 * The ratio is the PRIMARY (left) pane's fraction of the pair's width. It applies
 * only in the shared-pair layout — when a pane is maximized or docked to a rail
 * there's a single pane, so the ratio is inert. Persisted per-device (localStorage).
 *
 * `clampSplitRatio` is a pure helper (unit-tested) so the drag/keyboard math lives
 * in one place and can't drift between the pointer path and the arrow-key path.
 */
export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.25; // neither pane below a quarter of the pair
export const SPLIT_RATIO_MAX = 0.75;
export const SPLIT_RATIO_STEP = 0.04; // keyboard-arrow nudge
export const SPLIT_RATIO_KEY = 'storyos:split-ratio';

/** Clamp a desired primary-pane fraction into [MIN, MAX]; non-finite → default. */
export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/**
 * Convert an absolute pointer X into the primary-pane fraction, given the pair
 * region's left edge and width (both in CSS px). Keeps the "divider follows the
 * cursor" feel intuitive and clamps to the allowed band. A zero/omitted width
 * (region not yet measured) falls back to the default so a stray event can't
 * divide by zero.
 */
export function ratioFromPointer(clientX: number, regionLeft: number, regionWidth: number): number {
  if (!regionWidth || !Number.isFinite(regionWidth)) return SPLIT_RATIO_DEFAULT;
  return clampSplitRatio((clientX - regionLeft) / regionWidth);
}

/**
 * Split-ratio state, restored from localStorage on mount (SSR-guarded so the
 * server and first client render agree on the default). `setRatio` updates state
 * only (used live during a drag, no I/O per pointermove); `persist` also writes
 * localStorage (drag end, keyboard nudge, reset).
 */
export function useSplitRatio(
  /**
   * #356 — the storage key is a PARAMETER now, because a second draggable pair
   * exists (Tyron's panel) and the two must not overwrite each other's width.
   *
   * The ticket says "no new width logic, no second persistence key", and those
   * two halves pull apart: sharing ONE key means dragging Tyron silently resizes
   * the record split-screen and vice versa, which is a bug, not a feature. What
   * the rule is protecting against is a second *implementation* of the drag
   * math — so the module is reused verbatim and only the key varies.
   */
  key: string = SPLIT_RATIO_KEY,
  /** Tyron opens narrower than the record pair's 50/50 (#356). */
  defaultRatio: number = SPLIT_RATIO_DEFAULT,
) {
  const [ratio, setRatio] = useState(defaultRatio);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(key);
    if (raw == null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setRatio(clampSplitRatio(parsed));
  }, [key]);

  const persist = useCallback(
    (next: number) => {
      const clamped = clampSplitRatio(next);
      setRatio(clamped);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, String(clamped));
      }
    },
    [key],
  );

  return { ratio, setRatio, persist };
}

/**
 * #356 — Tyron's own key and default. Its ratio is the MAIN pane's fraction, so
 * "about a third" for the panel means about two thirds here. Deliberately
 * narrower than the record split's 50/50: the table has to keep its columns,
 * because seeing rows change is the entire argument for docking.
 */
export const TYRON_RATIO_KEY = 'storyos:tyron-ratio';
export const TYRON_RATIO_DEFAULT = 2 / 3;
