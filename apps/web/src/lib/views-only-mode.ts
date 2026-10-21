'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEditPreferenceList, usePreferences, withListEdit } from '@/lib/preferences';
import type { UserPreferences } from '@/lib/preferences';

/**
 * #742 finding 05 — "views-only mode": hide every database ROW in the sidebar
 * tree while keeping its views visible (flat, since there is then no parent row to nest them under, #931).
 *
 * #775 — the scope is DECIDED: per user, per workspace, stored server-side in the
 * user's preferences (`sidebar.viewsOnlyWorkspaces`, the same shape as
 * `activation.dismissedWorkspaces`). Not per space (moving between spaces would
 * flip it, which is the "button forgot" failure the design warns about), and not
 * a shared workspace setting (one person's display choice must not change what
 * anyone else sees — #736). localStorage is demoted to a cache of the last value
 * the server gave us, so the first paint after a reload doesn't flash the
 * databases before preferences arrive; it is never the source of truth once they
 * have.
 */
const legacyKey = (ws: string) => `storyos:views-only:${ws}`;
const cacheKey = (ws: string) => `storyos:views-only-cache:${ws}`;

export function isViewsOnly(list: string[] | undefined, ws: string): boolean {
  return (list ?? []).includes(ws);
}

function readLocal(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the server value still governs */
  }
}

export function useViewsOnlyMode(ws: string) {
  const prefs = usePreferences();
  const editList = useEditPreferenceList();
  const qc = useQueryClient();
  const list = prefs.data?.sidebar?.viewsOnlyWorkspaces;
  const loaded = prefs.data !== undefined;

  // Until the server answers, fall back to the cache so a reload doesn't flicker.
  const viewsOnly = loaded ? isViewsOnly(list, ws) : readLocal(cacheKey(ws)) === '1';

  useEffect(() => {
    if (!loaded) return;
    // One-time carry-over of the pre-#775 per-device flag, so nobody's sidebar
    // silently reverts on deploy. Server wins if it already has an opinion.
    if (readLocal(legacyKey(ws)) === '1') {
      writeLocal(legacyKey(ws), null);
      if (!isViewsOnly(list, ws)) {
        editList.mutate({ list: 'views_only_workspaces', add: [ws] });
        return;
      }
    }
    writeLocal(cacheKey(ws), isViewsOnly(list, ws) ? '1' : '0');
  }, [loaded, list, ws]);

  const toggle = () => {
    const on = !viewsOnly;
    // #1007 — one workspace id added or removed, never the whole list: the server applies it atomically, so another
    // tab's change to a different workspace survives.
    const edit = { list: 'views_only_workspaces' as const, ...(on ? { add: [ws] } : { remove: [ws] }) };
    // Optimistic: the button must respond instantly, not after a round trip.
    qc.setQueryData<UserPreferences>(['preferences'], (old) => (old ? withListEdit(old, edit) : old));
    writeLocal(cacheKey(ws), on ? '1' : '0');
    editList.mutate(edit, { onError: () => void qc.invalidateQueries({ queryKey: ['preferences'] }) });
  };

  return { viewsOnly, toggle };
}
