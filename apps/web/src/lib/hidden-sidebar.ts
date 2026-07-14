'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Per-user, per-device "hide from my sidebar" (#35). Stored in localStorage keyed by
 * workspace — a personal preference, never a workspace-wide change (mirrors the
 * per-space collapse pattern). A window event keeps every sidebar component that
 * reads it in sync without threading state through the tree.
 */
type HiddenKind = 'space' | 'database';

const storageKey = (ws: string) => `storyos:hidden:${ws}`;
const itemKey = (kind: HiddenKind, id: string) => `${kind}:${id}`;
const CHANGED = 'storyos:hidden-changed';

function read(ws: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(storageKey(ws)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function write(ws: string, set: Set<string>) {
  window.localStorage.setItem(storageKey(ws), JSON.stringify([...set]));
  window.dispatchEvent(new CustomEvent(CHANGED));
}

export function useHidden(ws: string) {
  const [hidden, setHidden] = useState<Set<string>>(() => read(ws));

  useEffect(() => {
    const sync = () => setHidden(read(ws));
    sync();
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [ws]);

  const isHidden = useCallback((kind: HiddenKind, id: string) => hidden.has(itemKey(kind, id)), [hidden]);
  const hide = useCallback(
    (kind: HiddenKind, id: string) => {
      const set = read(ws);
      set.add(itemKey(kind, id));
      write(ws, set);
    },
    [ws],
  );
  const unhide = useCallback(
    (kind: HiddenKind, id: string) => {
      const set = read(ws);
      set.delete(itemKey(kind, id));
      write(ws, set);
    },
    [ws],
  );

  return { hidden, isHidden, hide, unhide };
}
