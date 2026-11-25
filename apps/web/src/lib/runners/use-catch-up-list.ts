'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WaitingList } from './catch-up-list';

/**
 * Ticket #1224 - the waiting records by name. One read, shared by the box, the dialog and the Runs rows: the dialog shows the
 * first five of it, the Runs page one row per record (up to one click's worth, 25).
 *
 * Gated by the caller on the same condition as the count (the summary's `catch_up` is non-null), so a guest or another member
 * never makes the request. A 403, a 404 or a failure leaves `data` undefined: the page then shows the count UI it already had, never
 * an error. No retry: a refusal does not become an answer by asking again.
 */
export const CATCH_UP_LIST_LIMIT = 25;
export const catchUpListKey = (ws: string, agentId: string) => ['agent-catch-up-list', ws, agentId] as const;

export async function fetchCatchUpList(ws: string, agentId: string): Promise<WaitingList> {
  const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents/{agent}/catch-up', {
    params: { path: { ws, agent: agentId }, query: { limit: CATCH_UP_LIST_LIMIT, offset: 0 } },
  } as never);
  if (error) throw error;
  return data as unknown as WaitingList;
}

export function useCatchUpList(ws: string, agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: catchUpListKey(ws, agentId),
    queryFn: () => fetchCatchUpList(ws, agentId),
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}
