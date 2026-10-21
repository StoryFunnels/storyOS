'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * #967 — the numbers on the sidebar's gold AI section.
 *
 * Both are REAL counts from the API, never a guess (the "never guess numbers" rule that also kept My
 * Work off the rail: it has no count endpoint, so it has no badge). Where a count can be a lower bound
 * the label says so instead of printing the cap as if it were the total.
 */

/** `GET /approvals` returns at most this many rows (approvals.service.ts `limit: 100`). */
export const APPROVALS_LIST_LIMIT = 100;

/**
 * "" for nothing to show (zero is the common case and a gold 0 would be noise), the number
 * otherwise, and `N+` once the source is capped and the cap is reached — a capped list reaching its
 * cap means "at least this many", and printing it bare would be a confident wrong number.
 */
export function goldCountLabel(count: number, cap?: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (cap !== undefined && count >= cap) return `${cap}+`;
  return String(count);
}

/** Agent actions waiting for a person to approve them. */
export function usePendingApprovalCount(ws: string) {
  return useQuery({
    queryKey: ['approvals-pending-count', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals' as never, {
        params: { path: { ws }, query: { status: 'pending' } },
      } as never);
      if (error) throw error;
      return (data as unknown as unknown[]).length;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

interface InstalledPack {
  update_available: boolean;
}

/** Installed packs that have a newer version. Shares the cache entry the Packs page itself reads. */
export function usePackUpdateCount(ws: string) {
  return useQuery({
    queryKey: ['packs-installed', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/packs/installed' as never, {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as InstalledPack[];
    },
    select: (packs) => packs.filter((p) => p.update_available).length,
    staleTime: 60_000,
  });
}
