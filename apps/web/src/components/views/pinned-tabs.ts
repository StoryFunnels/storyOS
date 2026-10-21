import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ViewSummary } from './use-view-state';

/**
 * #966 — which views of a database THIS person keeps as tabs, in their order. Per-viewer state (ADR-0019),
 * served by PR 1166: GET/PUT/DELETE `/workspaces/{ws}/databases/{db}/pinned-tabs` -> `{ view_ids }`.
 *
 * What the API can and cannot say, because the strip is built on it:
 * - the list is the person's ORDER, and is already cleaned server-side (a trashed view drops out of the answer);
 * - "never pinned" and "pinned none" are the SAME answer, `[]`. So an empty list cannot mean "show no tabs": the
 *   strip falls back to the default view (see `stripViews`), and unpinning your last tab does the same.
 * - a pin may be a shared view or the person's own personal view. The strip only ever draws SHARED views (personal
 *   views live in the sidebar's Personal section), so `stripViews` skips personal ids and the menu never offers
 *   them a pin.
 */
export const pinnedTabsKey = (ws: string, db: string) => ['pinned-tabs', ws, db] as const;

const PATH = '/api/v1/workspaces/{ws}/databases/{db}/pinned-tabs' as const;

async function fetchPinned(ws: string, db: string): Promise<string[]> {
  const { data, error } = await api.GET(PATH, { params: { path: { ws, db } } });
  if (error) throw error;
  return ((data as unknown as { view_ids?: string[] } | undefined)?.view_ids ?? []).slice();
}

export function usePinnedTabs(ws: string, db: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: pinnedTabsKey(ws, db ?? ''),
    queryFn: () => fetchPinned(ws, db!),
    enabled: enabled && Boolean(db),
    // A pin changes only when this person (or this person on another device) changes it.
    staleTime: 60_000,
  });
}

/** The full ordered list in, the saved list out: the endpoint replaces, it does not patch. */
function useSetPinnedTabs(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (view_ids: string[]) => {
      const { data, error } = await api.PUT(PATH, {
        params: { path: { ws, db } },
        body: { view_ids } as never,
      });
      if (error) throw error;
      return (
        (data as unknown as { view_ids?: string[] } | undefined)?.view_ids ?? view_ids
      ).slice();
    },
    // Optimistic: the strip must not lag a click, and a failed save rolls back to what was there.
    onMutate: async (view_ids) => {
      await qc.cancelQueries({ queryKey: pinnedTabsKey(ws, db) });
      const before = qc.getQueryData<string[]>(pinnedTabsKey(ws, db));
      qc.setQueryData(pinnedTabsKey(ws, db), view_ids);
      return { before };
    },
    onError: (_e, _ids, ctx) => {
      qc.setQueryData(pinnedTabsKey(ws, db), ctx?.before);
      toast.error('Could not save your tabs');
    },
    onSuccess: (saved) => qc.setQueryData(pinnedTabsKey(ws, db), saved),
  });
}

/**
 * Read-modify-write against the SERVER's current list, not the cache: the sidebar door reads the cache lazily, so
 * it may be stale, and a PUT of a stale list would silently undo a pin made on another device.
 */
async function currentList(qc: QueryClient, ws: string, db: string): Promise<string[]> {
  return qc.fetchQuery({
    queryKey: pinnedTabsKey(ws, db),
    queryFn: () => fetchPinned(ws, db),
    staleTime: 0,
  });
}

export interface ViewPins {
  /** The person's pinned ids, in order (may include personal ids; the strip ignores those). */
  pinned: string[];
  isPinned: (viewId: string) => boolean;
  /** Idempotent: it states the wanted outcome, so a stale label can never invert it. */
  setPinned: (viewId: string, wanted: boolean) => void;
  /** Persist a new order for the pinned tabs. */
  reorder: (ids: string[]) => void;
}

export function useViewPins(ws: string, db: string | null | undefined, enabled = true): ViewPins {
  const qc = useQueryClient();
  const query = usePinnedTabs(ws, db, enabled);
  const set = useSetPinnedTabs(ws, db ?? '');
  const pinned = query.data ?? [];
  const setPinned = useCallback(
    (viewId: string, wanted: boolean) => {
      if (!db) return;
      void currentList(qc, ws, db).then((list) => {
        const next = withPin(list, viewId, wanted);
        if (next !== list) set.mutate(next);
      });
    },
    [qc, ws, db],
  );
  return {
    pinned,
    isPinned: (id) => pinned.includes(id),
    setPinned,
    reorder: (ids) => set.mutate(ids),
  };
}

/** Adds (at the end) or removes one id; returns the SAME array when nothing changes, so a caller can skip the save. */
export function withPin(list: string[], viewId: string, wanted: boolean): string[] {
  const has = list.includes(viewId);
  if (wanted === has) return list;
  return wanted ? [...list, viewId] : list.filter((id) => id !== viewId);
}

/**
 * The tabs to draw. Only SHARED views (personal views are the sidebar's), in the person's own order, then:
 * - the ACTIVE view even if it is not pinned, so the strip always shows where you are. It sits at the end, is not
 *   draggable, and disappears when you navigate away: the strip "never grows on its own".
 * - with nothing pinned (never set, or just unpinned the last), the default view, so there is never an empty strip.
 */
export function stripViews(
  views: ViewSummary[],
  pinnedIds: string[],
  activeId: string | undefined,
): { view: ViewSummary; pinned: boolean }[] {
  const shared = views.filter((v) => !v.ownerUserId);
  const byId = new Map(shared.map((v) => [v.id, v]));
  const out = pinnedIds.flatMap((id) => {
    const view = byId.get(id);
    return view ? [{ view, pinned: true }] : [];
  });
  const active = activeId ? byId.get(activeId) : undefined;
  if (active && !out.some((t) => t.view.id === active.id))
    out.push({ view: active, pinned: false });
  if (out.length === 0) {
    const fallback = shared.find((v) => v.isDefault) ?? shared[0];
    if (fallback) out.push({ view: fallback, pinned: false });
  }
  return out;
}

/**
 * A drag within the strip reorders the PINNED tabs only. `visibleIds` are the pinned ids as drawn; ids in the
 * stored list that the strip does not draw (a personal view pinned elsewhere) keep their relative place at the end.
 */
export function reorderPinned(
  stored: string[],
  visibleIds: string[],
  activeId: string,
  overId: string,
): string[] | null {
  const from = visibleIds.indexOf(activeId);
  const to = visibleIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = visibleIds.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return [...next, ...stored.filter((id) => !visibleIds.includes(id))];
}

/** The databases a view reads from, by name. An ordinary view reads this one; a dashboard also reads each tile's. */
export function viewSources(
  view: Pick<ViewSummary, 'type' | 'config'>,
  ownName: string,
  ownId: string,
  nameOf: (databaseId: string) => string | undefined,
): string[] {
  const names = [ownName];
  if (view.type === 'dashboard') {
    const ids = [...(view.config.dashboard_tiles ?? []), ...(view.config.dashboard_widgets ?? [])]
      .map((t) => t.database_id)
      .filter((id): id is string => Boolean(id) && id !== ownId);
    for (const id of new Set(ids)) {
      const n = nameOf(id);
      if (n && !names.includes(n)) names.push(n);
    }
  }
  return names;
}

export interface SwitcherGroups {
  pinned: ViewSummary[];
  all: ViewSummary[];
}

/** Shared views only, filtered by name or by a source's name; the Pinned group keeps the person's order. */
export function switcherGroups(
  views: ViewSummary[],
  pinnedIds: string[],
  query: string,
  sourcesOf: (v: ViewSummary) => string[],
): SwitcherGroups {
  const q = query.trim().toLowerCase();
  const shared = views.filter((v) => !v.ownerUserId);
  const matches = (v: ViewSummary) =>
    !q || v.name.toLowerCase().includes(q) || sourcesOf(v).some((s) => s.toLowerCase().includes(q));
  const byId = new Map(shared.map((v) => [v.id, v]));
  return {
    pinned: pinnedIds.flatMap((id) => {
      const v = byId.get(id);
      return v && matches(v) ? [v] : [];
    }),
    all: shared.filter(matches),
  };
}
