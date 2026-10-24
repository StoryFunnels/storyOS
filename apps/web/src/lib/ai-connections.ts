'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * #1030 — the AI clients the signed-in person has connected, and the way to disconnect one.
 * Mirrors `AiConnection` in `apps/api/src/workspaces/ai-connections.service.ts` (ticket #1008).
 */
export interface AiConnection {
  /** `oauth:<client id>` or `token:<token id>` — what DELETE takes. */
  id: string;
  kind: 'oauth' | 'token';
  client_name: string;
  connected_at: string | null;
  /** Tokens record it; OAuth does not, so null means "not recorded" for OAuth and "never used" for a token. */
  last_used_at: string | null;
  reaches: 'all_your_workspaces' | 'this_workspace';
}

export const aiConnectionsKey = (ws: string) => ['ai-connections', ws] as const;

export function useAiConnections(ws: string) {
  return useQuery({
    queryKey: aiConnectionsKey(ws),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me/ai-connections', { params: { query: { workspace_id: ws } } });
      if (error) throw error;
      return (data as unknown as { data: AiConnection[] }).data;
    },
  });
}

export function useDisconnectAiConnection(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/me/ai-connections/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Disconnected');
      void qc.invalidateQueries({ queryKey: aiConnectionsKey(ws) });
      // The "is any AI connected" fact the checklist and the gold sidebar section read.
      void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
    },
    onError: () => toast.error('Could not disconnect. Try again in a moment.'),
  });
}

export interface ConnectionWords {
  how: string;
  reaches: string;
  confirmTitle: string;
  confirmMessage: string;
}

/** The words for one connection, in one place so the row and its confirmation can never describe different things. */
export function connectionWords(c: Pick<AiConnection, 'kind' | 'client_name' | 'reaches'>): ConnectionWords {
  const reaches = c.reaches === 'all_your_workspaces' ? 'All your workspaces' : 'This workspace only';
  if (c.kind === 'oauth') {
    return {
      how: 'Connected by signing in',
      reaches,
      confirmTitle: `Disconnect ${c.client_name}?`,
      confirmMessage: `${c.client_name} loses access to every workspace you are in, right away. It can ask to connect again, and you will be asked to allow it.`,
    };
  }
  return {
    how: 'Personal access token',
    reaches,
    confirmTitle: `Disconnect ${c.client_name}?`,
    confirmMessage: 'This token stops working right away. Anything still using it will start failing.',
  };
}

/** What to print for "last used". Null is NOT the same fact for both kinds, and neither is rendered as a guess. */
export function lastUsedText(c: Pick<AiConnection, 'kind' | 'last_used_at'>, date: (v: unknown) => string): string {
  if (c.last_used_at) return `Last used ${date(c.last_used_at)}`;
  return c.kind === 'token' ? 'Never used' : 'Last use not recorded';
}
