'use client';

import { useEffect, useState } from 'react';

/**
 * #742 finding 05 — "views-only mode": hide every database ROW in the sidebar
 * tree while keeping its views (flat siblings since finding 06) visible. A
 * per-user, per-device preference like `useHidden`'s hide-from-sidebar flag —
 * not a workspace setting, since what someone wants to see in THEIR sidebar
 * says nothing about what anyone else should see in theirs.
 */
const storageKey = (ws: string) => `storyos:views-only:${ws}`;
const CHANGED = 'storyos:views-only-changed';

function read(ws: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(storageKey(ws)) === '1';
}

export function useViewsOnlyMode(ws: string) {
  const [viewsOnly, setViewsOnly] = useState(false);

  useEffect(() => {
    const sync = () => setViewsOnly(read(ws));
    sync();
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [ws]);

  const toggle = () => {
    const next = !read(ws);
    window.localStorage.setItem(storageKey(ws), next ? '1' : '0');
    window.dispatchEvent(new CustomEvent(CHANGED));
  };

  return { viewsOnly, toggle };
}
