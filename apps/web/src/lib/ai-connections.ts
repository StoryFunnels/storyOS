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
  /** `one_workspace`: bound to `workspace` at level `access` (#1030). `reconnect_needed`: no usable approval, the server refuses it. */
  reaches: 'one_workspace' | 'reconnect_needed' | 'this_workspace';
  workspace: { id: string; name: string } | null;
  access: 'read' | 'write' | null;
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

const ACCESS_LABEL = { read: 'Read only', write: 'Read and write' } as const;

/** The words for one connection, in one place so the row and its confirmation can never describe different things. */
export function connectionWords(c: Pick<AiConnection, 'kind' | 'client_name' | 'reaches' | 'workspace' | 'access'>): ConnectionWords {
  const confirmTitle = `Disconnect ${c.client_name}?`;
  if (c.kind === 'token') {
    return {
      how: 'Personal access token',
      reaches: 'This workspace only',
      confirmTitle,
      confirmMessage: 'This token stops working right away. Anything still using it will start failing.',
    };
  }
  if (c.reaches === 'one_workspace' && c.workspace) {
    const level = c.access ? ACCESS_LABEL[c.access] : null;
    return {
      how: 'Connected by signing in',
      reaches: `${c.workspace.name} only${level ? ` · ${level}` : ''}`,
      confirmTitle,
      confirmMessage: `${c.client_name} loses access to ${c.workspace.name} right away. It can ask to connect again, and you will be asked to allow it.`,
    };
  }
  // No usable approval: it was connected before a workspace and level were chosen, or its workspace is one you are not in.
  // StoryOS refuses it, so it is shown as what it is, never as access it does not have.
  return {
    how: 'Connected by signing in',
    reaches: 'Reconnect needed',
    confirmTitle,
    confirmMessage: `${c.client_name} no longer works: it has no approved workspace. Disconnecting removes it, and you can connect it again to choose a workspace.`,
  };
}

/** What to print for "last used". Null is NOT the same fact for both kinds, and neither is rendered as a guess. */
export function lastUsedText(c: Pick<AiConnection, 'kind' | 'last_used_at'>, date: (v: unknown) => string): string {
  if (c.last_used_at) return `Last used ${date(c.last_used_at)}`;
  return c.kind === 'token' ? 'Never used' : 'Last use not recorded';
}
