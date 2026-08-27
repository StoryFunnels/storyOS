'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Which Tyron conversation you were last in (#403).
 *
 * The thread id lived in component state, so closing the panel unmounted it and
 * reopening started from nothing. The data was never lost — #359 shipped
 * `tyron_threads` + `tyron_messages`, they persist correctly, and
 * `GET /workspaces/:ws/tyron/threads` returns them. The panel simply never
 * remembered which thread it was on and never asked for the list.
 *
 * That is a seam failure rather than a coding mistake: #359 built the storage
 * half and left the reachable half to #356, and #356 shipped the panel without
 * it. Neither ticket was wrong on its own and the feature was still unusable.
 *
 * PER WORKSPACE, deliberately. One key for all of them would resume a
 * conversation from somewhere else after a workspace switch — a thread is
 * scoped to a workspace on the server, so the id would 404 and the panel would
 * look broken for a reason the user could not see.
 *
 * localStorage rather than a new mechanism, exactly as the panel's own width and
 * collapse state already do (`storyos:tyron-panel`, `storyos:tyron-ratio`).
 */
export const keyFor = (ws: string) => `storyos:tyron-thread:${ws}`;

export function readRememberedThread(ws: string): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(keyFor(ws));
}

export function rememberThread(ws: string, threadId: string | null): void {
  if (typeof window === 'undefined') return;
  if (threadId) window.localStorage.setItem(keyFor(ws), threadId);
  else window.localStorage.removeItem(keyFor(ws));
}

/**
 * The remembered thread, kept in sync with storage.
 *
 * Starts `null` on both the server and the first client render, then reads —
 * the same hydration dance `useTyronPanel` does, for the same reason: reading
 * localStorage during render makes the markup differ between server and client.
 */
export function useRememberedThread(ws: string): {
  threadId: string | null;
  setThreadId: (id: string | null) => void;
  hydrated: boolean;
} {
  const [threadId, setState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(readRememberedThread(ws));
    setHydrated(true);
  }, [ws]);

  const setThreadId = useCallback(
    (id: string | null) => {
      setState(id);
      rememberThread(ws, id);
    },
    [ws],
  );

  return { threadId, setThreadId, hydrated };
}
