'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * #834 / #962 — "is the entry behind me INSIDE the app?", and the ONE back/close rule.
 *
 * Esc on a record, the record's ✕, a split panel's ✕, the error page's Back and the
 * overlay engine all ask this same question, because the answer decides whether `back()`
 * is safe: when the previous entry is a StoryOS page it is exactly "return to where I was";
 * when it is not (a pasted link, a new tab, a reload) it would leave the product or do
 * nothing, so the caller goes to the PARENT place instead.
 *
 * `window.history.length` cannot answer it (it counts entries from before the app), and
 * `document.referrer` does not change on a client-side navigation. So every entry the app
 * creates is stamped with its own index in `history.state`, and "can go back" is "my index
 * is above the one this document load started at". A reload keeps the stamp, so it resets
 * the base to wherever it landed — entries behind a reload are never claimed as ours.
 *
 * `history.length` and a raw `history.back()` are banned everywhere else
 * (`nav-trail.unit.test.ts` fails the build on a new one): they are how a close control
 * ends up leaving the product.
 */
export const INDEX_KEY = '__sosIdx';
/** Entries that are a PAGE, as opposed to the overlay engine's guard entries (below). */
export const PAGE_KEY = '__sosPg';
/** Marks the history entry the overlay engine pushes while a layer is open. */
export const GUARD_KEY = '__sosGuard';

/** The slice of `History` the tracker touches — an interface so the rule is unit-tested
 *  without a DOM (the repo's vitest runs in a plain-node environment). */
export interface HistoryLike {
  state: unknown;
  pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const numAt = (state: unknown, key: string) => {
  const n = asRecord(state)[key];
  return typeof n === 'number' ? n : 0;
};
export const isGuardState = (state: unknown) => asRecord(state)[GUARD_KEY] === true;

export interface Traversal {
  dir: 'back' | 'forward' | 'none';
  /** The entry we moved OFF was an overlay guard. */
  leftGuard: boolean;
  /** The entry we moved ONTO is an overlay guard. */
  onGuard: boolean;
}

export interface HistoryTracker {
  /** Index of the entry the browser is on now (0 for one the app did not create). */
  index: () => number;
  /** How many PAGES this load has pushed — an overlay's guard entry is not one. */
  page: () => number;
  /** The page depth this document load started at. */
  base: number;
  canGoBack: () => boolean;
  /** Call once per `popstate`: which way did the browser just move, and was a guard
   *  involved? Needs no DOM — the stamped index against the last one seen, kept fresh by
   *  every push and replace. */
  traversed: () => Traversal;
}

/**
 * Stamps every pushed entry with `index + 1` (and a page depth that a guard entry does not
 * advance) and every replaced entry with its own. Wraps whatever `pushState`/`replaceState`
 * are installed at call time, so it composes with the router's own patch (Next integrates
 * `history.pushState` calls itself).
 */
export function trackHistory(history: HistoryLike): HistoryTracker {
  const index = () => numAt(history.state, INDEX_KEY);
  const page = () => numAt(history.state, PAGE_KEY);
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const base = page();
  let last = index();
  let lastGuard = isGuardState(history.state);
  const settle = () => {
    last = index();
    lastGuard = isGuardState(history.state);
  };
  history.pushState = (data, unused, url) => {
    const guard = asRecord(data)[GUARD_KEY] === true;
    push({ ...asRecord(data), [INDEX_KEY]: index() + 1, [PAGE_KEY]: page() + (guard ? 0 : 1) }, unused, url);
    settle();
  };
  history.replaceState = (data, unused, url) => {
    replace({ ...asRecord(data), [INDEX_KEY]: index(), [PAGE_KEY]: page() }, unused, url);
    settle();
  };
  // The entry this load started on is part of the trail too: stamp it, keeping what the
  // router already stored there.
  if (typeof asRecord(history.state)[INDEX_KEY] !== 'number') {
    replace({ ...asRecord(history.state), [INDEX_KEY]: 0, [PAGE_KEY]: 0 }, '');
    settle();
  }
  return {
    index,
    page,
    base,
    canGoBack: () => page() > base,
    traversed: () => {
      const now = index();
      const dir = now < last ? 'back' : now > last ? 'forward' : 'none';
      const out: Traversal = { dir, leftGuard: lastGuard, onGuard: isGuardState(history.state) };
      settle();
      return out;
    },
  };
}

let tracker: HistoryTracker | null = null;
let lastTraversal: Traversal = { dir: 'none', leftGuard: false, onGuard: false };

/**
 * Installs the tracker once per document load. Idempotent; a no-op on the server.
 *
 * The traversal is read in a CAPTURE listener registered here, ahead of the router's own `popstate` handler:
 * the router writes to history while handling a traversal (it replaces the entry's state), and that write
 * would otherwise make the move look like it never happened by the time a later listener asked.
 */
export function installHistoryTracking(): HistoryTracker | null {
  if (typeof window === 'undefined') return null;
  if (!tracker) {
    const t = trackHistory(window.history);
    tracker = t;
    window.addEventListener('popstate', () => (lastTraversal = t.traversed()), true);
  }
  return tracker;
}

export function canGoBackInApp(): boolean {
  return tracker?.canGoBack() ?? false;
}

/** How the browser just moved, for the `popstate` being handled. */
export function traversed(): Traversal {
  return lastTraversal;
}

/** Mount once, high in the workspace tree. Keeps the name #834 shipped with. */
export function useTrackAppNavigation() {
  useEffect(() => {
    installHistoryTracking();
  }, []);
}

/**
 * The one back/close rule. Go back if the previous entry is inside the app, otherwise
 * go to the PARENT place — and REPLACE to it, so closing a pasted record does not leave
 * the record one Back away from the page you closed it to.
 */
export function backOrParent(
  router: { back: () => void; replace: (href: string) => void },
  parentHref: string,
): void {
  if (canGoBackInApp()) router.back();
  else router.replace(parentHref);
}

/** `backOrParent` bound to the router, for a close / back control. */
export function useBackOrParent(parentHref: string): () => void {
  const router = useRouter();
  return useCallback(() => backOrParent(router, parentHref), [router, parentHref]);
}
