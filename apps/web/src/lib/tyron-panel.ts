'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Tyron's panel state (#356).
 *
 * FOUR states, and they are the record split-screen's states at a different
 * default width — not a new layout model:
 *
 * - `third`  — working width, about a third. The default.
 * - `half`   — the existing 50/50 pair.
 * - `full`   — the whole window, WITH THE LEFT SIDEBAR HIDDEN. Founder, verbatim:
 *              "By full I mean everything without left main sidebar."
 * - `closed` — collapsed to the rail.
 *
 * `third` vs `half` is a width, so both are the same layout with a different
 * ratio; the state below records which one the user chose so the header controls
 * can show it, and so `full` knows what to restore to.
 */
export type TyronPanelState = 'closed' | 'third' | 'half' | 'full';

const KEY = 'storyos:tyron-panel';
const CHANGED = 'storyos:tyron-panel-changed';
export const OPEN_TYRON_EVENT = 'storyos:open-tyron';

/**
 * Ask for the panel from anywhere — the sidebar entry, the command palette, the
 * ⌘J shortcut. An event rather than a shared store because the openers are in
 * different trees, and this is the same pattern `openPalette()` already uses.
 */
export function openTyron() {
  window.dispatchEvent(new CustomEvent(OPEN_TYRON_EVENT));
}

function read(): TyronPanelState {
  if (typeof window === 'undefined') return 'closed';
  const raw = window.localStorage.getItem(KEY);
  return raw === 'third' || raw === 'half' || raw === 'full' ? raw : 'closed';
}

export function useTyronPanel() {
  // Starts 'closed' on both server and first client render, then syncs — the
  // same hydration tradeoff every other localStorage-backed toggle here makes.
  const [state, setState] = useState<TyronPanelState>('closed');

  useEffect(() => {
    setState(read());
    const sync = () => setState(read());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  const apply = useCallback((next: TyronPanelState) => {
    window.localStorage.setItem(KEY, next);
    window.dispatchEvent(new CustomEvent(CHANGED));
    setState(next);
  }, []);

  /**
   * Opening restores the last WIDTH the user chose, never `full`.
   *
   * Reopening into full-screen would be a jarring way to answer a click on a
   * sidebar entry — the user asked for the assistant, not for the rest of the
   * app to disappear. `full` is deliberately not a sticky preference.
   */
  const open = useCallback(() => {
    apply(read() === 'half' ? 'half' : 'third');
  }, [apply]);

  return { state, set: apply, open, close: useCallback(() => apply('closed'), [apply]) };
}
