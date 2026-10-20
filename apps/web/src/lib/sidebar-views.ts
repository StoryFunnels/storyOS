'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * #931 — a database's saved views nest under it, COLLAPSED by default.
 *
 * A collapsed database is one row, except that a view you can lose track of still shows: the
 * ACTIVE one (you are on it) and any PINNED one (you chose to keep it in reach, #966). Hiding the
 * view you are looking at would make the tree lie about where you are.
 *
 * Pure, so the rule is testable without a render. Order is the caller's order, never re-sorted:
 * a view's place among its siblings is the user's (drag-reorder), and collapsing must not move it.
 */
export function visibleChildViews<V extends { id: string }>(
  views: readonly V[],
  opts: { expanded: boolean; activeViewId: string | null; pinnedIds?: ReadonlySet<string> },
): V[] {
  if (opts.expanded) return [...views];
  return views.filter((v) => v.id === opts.activeViewId || opts.pinnedIds?.has(v.id));
}

/** Per-user, per-device, like every other sidebar open/closed preference (see sidebar.tsx). */
export function databaseViewsExpandedKey(ws: string, databaseId: string): string {
  return `storyos:sidebar-db-views-expanded:${ws}:${databaseId}`;
}

/**
 * Read lazily in an effect, not in the useState initializer, so the server render and the first
 * client render agree (no hydration mismatch) — the same tradeoff every localStorage-backed toggle
 * in this app makes. Default is COLLAPSED: no stored value means closed.
 */
export function useDatabaseViewsExpanded(ws: string, databaseId: string) {
  const key = databaseViewsExpandedKey(ws, databaseId);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      setExpanded(window.localStorage.getItem(key) === '1');
    } catch {
      // Storage can be unavailable (private window, blocked site data): stay collapsed.
    }
  }, [key]);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // The toggle still works for this session; it just won't be remembered.
      }
      return next;
    });
  }, [key]);

  return [expanded, toggle] as const;
}
