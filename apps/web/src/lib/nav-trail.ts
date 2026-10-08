'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * #834 — "did the person get here by navigating inside the app?"
 *
 * Esc on a full-page record should return to the view it was opened from. `router.back()`
 * is right when that view is behind us in THIS tab's app history; if the record URL was
 * opened directly (a pasted link, a new tab), `back()` would leave the product or do
 * nothing, so the caller falls back to the database's own view instead.
 *
 * `history.length` cannot answer this (it counts entries from before the app), and
 * `document.referrer` does not change on a client-side navigation. A module-level count
 * of route changes does, and it resets on a full page load — exactly when "in-app history"
 * does too.
 */
let routeChanges = 0;

export function canGoBackInApp(): boolean {
  return routeChanges > 0;
}

export function useTrackAppNavigation() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    // Counted on a CHANGE only, from a ref: counting in an effect cleanup also fires on
    // React's dev double-mount, which would claim in-app history on a directly opened URL.
    if (previous.current !== null && previous.current !== pathname) routeChanges += 1;
    previous.current = pathname;
  }, [pathname]);
}
