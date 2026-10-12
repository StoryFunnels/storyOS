'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SocialConnection {
  id: string;
  name: string;
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

/**
 * The workspace's LinkedIn and X connections. Its own query key on purpose: `useMailConnections`
 * caches a FILTERED list under `['connections', ws]`, so sharing that key would hand this hook the
 * mail connections (or the reverse) depending on which mounted first.
 */
export function useSocialConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws, 'social'],
    enabled: Boolean(ws),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: SocialConnection[] }).data.filter((c) => ['linkedin', 'x'].includes(c.provider));
    },
  });
}

export interface PendingApproval {
  id: string;
  status: string;
  /** `{ ctx, action }`: the rendered action is under `.action` (approvals.service.ts ApprovalActionSnapshot). */
  action_snapshot: { action?: { type?: string } & Record<string, unknown> } | null;
}

/** Pending approvals, once per workspace; a row picks its own out by id instead of fetching the list again. */
export function usePendingApprovals(ws: string, enabled: boolean) {
  return useQuery({
    queryKey: ['approvals-pending', ws],
    enabled: Boolean(ws) && enabled,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals', {
        params: { path: { ws }, query: { status: 'pending' } },
      } as never);
      if (error) throw error;
      return data as unknown as PendingApproval[];
    },
  });
}
