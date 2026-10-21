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

/**
 * #967 — "Connect your AI": shown (gold "1" and a tint) until this workspace has a connected AI client, then gone.
 * "Connected" is Otto's FINAL definition (ticket #967, PR 1145): `ai_connected || mcp_oauth_connected` from
 * GET /workspaces/{ws}/onboarding. Any connected AI counts, a token or an OAuth grant; a teammate's connection counts
 * for the whole workspace. A key an older server omits reads as false.
 */
export interface AiConnectedState {
  ai_connected?: boolean;
  mcp_oauth_connected?: boolean;
}

export function isAiConnected(state: AiConnectedState | undefined): boolean {
  return Boolean(state?.ai_connected || state?.mcp_oauth_connected);
}

/**
 * Whether the row shows. `undefined` (still loading, or the request failed) is NOT "not connected": a nudge must
 * not flash for someone who is connected, and an error must not nag, so the row waits for a real answer.
 */
export function showConnectAiRow(connected: boolean | undefined): boolean {
  return connected === false;
}

/** The toast's hint id (stored per viewer in dismissed hints, so it appears once, ever). */
export const CONNECT_AI_MOVED_HINT = 'connect-ai-moved-toast';
export const CONNECT_AI_MOVED_TOAST = 'Connect your AI now lives in Settings';

/**
 * The one-time toast on FIRST connect: it fires when the workspace goes from a known "not connected" to connected
 * while the sidebar is open (e.g. the person returns from claude.ai and the window-focus refetch lands), and never
 * again once its hint is stored. It says where the row went, because the row has just disappeared under them.
 */
export function shouldAnnounceMove(previous: boolean | undefined, now: boolean | undefined, alreadyShown: boolean | undefined): boolean {
  return previous === false && now === true && alreadyShown === false;
}

/** Shares the cache entry the workspace home's onboarding card reads, so it is one request. */
export function useAiConnected(ws: string) {
  return useQuery({
    queryKey: ['onboarding', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/onboarding' as never, {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as AiConnectedState;
    },
    select: isAiConnected,
    retry: false,
    // Coming back from claude.ai after connecting must update the row NOW, not after a staleness window.
    refetchOnWindowFocus: 'always',
  });
}
