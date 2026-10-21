import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * #976 — one-time explainer cards ("hints") a person has hidden, per workspace. Per-viewer state (ADR-0019), served by
 * PR 1166: GET/PUT/DELETE `/workspaces/{ws}/dismissed-hints` -> `{ hint_ids }`. A hint id is a short stable key the
 * CLIENT chooses; the server does not enumerate them, so the next card needs no API change. NOT localStorage: the
 * choice follows the person across devices and a teammate's choice never changes yours.
 */
export const dismissedHintsKey = (ws: string) => ['dismissed-hints', ws] as const;

const PATH = '/api/v1/workspaces/{ws}/dismissed-hints' as const;

async function fetchHints(ws: string): Promise<string[]> {
  const { data, error } = await api.GET(PATH, { params: { path: { ws } } });
  if (error) throw error;
  return ((data as unknown as { hint_ids?: string[] } | undefined)?.hint_ids ?? []).slice();
}

/** Adds or removes one id; returns the SAME array when nothing changes, so the caller can skip the save. */
export function withHint(list: string[], hintId: string, dismissed: boolean): string[] {
  const has = list.includes(hintId);
  if (dismissed === has) return list;
  return dismissed ? [...list, hintId] : list.filter((id) => id !== hintId);
}

export function useDismissedHints(ws: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: dismissedHintsKey(ws),
    queryFn: () => fetchHints(ws),
    enabled: Boolean(ws),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: async (hint_ids: string[]) => {
      const { data, error } = await api.PUT(PATH, {
        params: { path: { ws } },
        body: { hint_ids } as never,
      });
      if (error) throw error;
      return (
        (data as unknown as { hint_ids?: string[] } | undefined)?.hint_ids ?? hint_ids
      ).slice();
    },
    onMutate: async (hint_ids) => {
      await qc.cancelQueries({ queryKey: dismissedHintsKey(ws) });
      const before = qc.getQueryData<string[]>(dismissedHintsKey(ws));
      qc.setQueryData(dismissedHintsKey(ws), hint_ids);
      return { before };
    },
    onError: (_e, _ids, ctx) => {
      qc.setQueryData(dismissedHintsKey(ws), ctx?.before);
      toast.error('Could not save that');
    },
    onSuccess: (saved) => qc.setQueryData(dismissedHintsKey(ws), saved),
  });
  /** Idempotent, and read-modify-write against the SERVER's list so a dismissal on another device is not undone. */
  const setDismissed = useCallback(
    (hintId: string, dismissed: boolean) => {
      void qc
        .fetchQuery({
          queryKey: dismissedHintsKey(ws),
          queryFn: () => fetchHints(ws),
          staleTime: 0,
        })
        .then((list) => {
          const next = withHint(list, hintId, dismissed);
          if (next !== list) save.mutate(next);
        });
    },
    [qc, ws],
  );
  return {
    /** undefined while loading: a card must not flash open for someone who hid it. */
    dismissed: query.data,
    isDismissed: (hintId: string) => query.data?.includes(hintId),
    setDismissed,
  };
}
