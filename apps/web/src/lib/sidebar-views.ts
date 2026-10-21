'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * #931 — a database's saved views nest under it, COLLAPSED by default.
 *
 * #993 — and a collapsed database is ONE row, full stop. It used to keep the active view (and any pinned one) on show,
 * which made the caret lie: it pointed "collapsed" over a row that stayed, and clicking it changed nothing. The location
 * is not lost by hiding the row: the database row itself carries the "you are here" highlight while it is collapsed
 * (`databaseRowActive`), and opening a view auto-expands its database ONCE (`shouldAutoExpand`).
 *
 * Pure, so the rule is testable without a render. Order is the caller's order, never re-sorted: a view's place among its
 * siblings is the user's (drag-reorder), and collapsing must not move it.
 */
export function visibleChildViews<V extends { id: string }>(views: readonly V[], opts: { expanded: boolean }): V[] {
  return opts.expanded ? [...views] : [];
}

/**
 * Which row wears the "you are here" highlight. On the database's own pages it is the database row, EXCEPT while the
 * database is expanded and the active view is one of its rows, which then carries it instead — one highlight, never two.
 */
export function databaseRowActive(opts: { isHere: boolean; expanded: boolean; activeViewShown: boolean }): boolean {
  return opts.isHere && !(opts.expanded && opts.activeViewShown);
}

/**
 * Whether landing on `activeViewId` should open its database. ONCE per view: `lastAutoExpandedFor` is the view this
 * session already opened it for, so a person who then collapses it stays collapsed (also across a reload), and
 * navigating to a DIFFERENT view of the same database opens it again.
 */
export function shouldAutoExpand(activeViewId: string | null, lastAutoExpandedFor: string | null): boolean {
  return activeViewId !== null && activeViewId !== lastAutoExpandedFor;
}

/** Session-scoped on purpose: "once" means once per visit, not once ever. */
export function autoExpandedKey(ws: string, databaseId: string): string {
  return `storyos:sidebar-db-autoexpanded:${ws}:${databaseId}`;
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
export function useDatabaseViewsExpanded(ws: string, databaseId: string, activeViewId: string | null = null) {
  const key = databaseViewsExpandedKey(ws, databaseId);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      setExpanded(window.localStorage.getItem(key) === '1');
    } catch {
      // Storage can be unavailable (private window, blocked site data): stay collapsed.
    }
  }, [key]);

  // #993 — landing on one of this database's views opens it, ONCE per view per session (see `shouldAutoExpand`).
  useEffect(() => {
    const seenKey = autoExpandedKey(ws, databaseId);
    let seen: string | null = null;
    try {
      seen = window.sessionStorage.getItem(seenKey);
    } catch {
      // No session storage: the rule degrades to "open on each landing", which is still only on navigation.
    }
    if (!shouldAutoExpand(activeViewId, seen)) return;
    try {
      window.sessionStorage.setItem(seenKey, activeViewId!);
      window.localStorage.setItem(key, '1');
    } catch {
      /* the in-memory state below still opens it for this page */
    }
    setExpanded(true);
  }, [ws, databaseId, activeViewId, key]);

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
