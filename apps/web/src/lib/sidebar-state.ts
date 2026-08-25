'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Desktop (md+) sidebar collapse toggle (MN-230b). Per-user, per-device
 * preference stored in localStorage — mirrors the per-space collapse pattern
 * in sidebar.tsx and the useHidden hook (lib/hidden-sidebar.ts). Not scoped to
 * a workspace: it's a shell-level layout preference, not workspace content.
 *
 * Read lazily in an effect (not in useState's initializer) so server and first
 * client render agree — avoids a hydration mismatch, same tradeoff every other
 * localStorage-backed toggle in this app makes.
 */
const KEY = 'storyos:sidebar-collapsed';
const CHANGED = 'storyos:sidebar-collapsed-changed';

function read(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(KEY) === '1';
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(read());
    const sync = () => setCollapsed(read());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  const apply = useCallback((next: boolean) => {
    window.localStorage.setItem(KEY, next ? '1' : '0');
    window.dispatchEvent(new CustomEvent(CHANGED));
    setCollapsed(next);
  }, []);

  const toggle = useCallback(() => apply(!read()), [apply]);

  /**
   * #356 — an EXPLICIT setter, so Tyron's FULL state can hide the sidebar and
   * restore it through this same mechanism instead of adding a second way to
   * hide the sidebar. `toggle` cannot express "make sure it is hidden" — entering
   * FULL twice would flip it back on, and restoring would depend on what the user
   * had done in between.
   *
   * It writes through the same key and fires the same CHANGED event, so every
   * other listener stays in step.
   */
  return { collapsed, toggle, setCollapsed: apply };
}
