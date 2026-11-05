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
  /**
   * `all_workspaces`: an OAuth connection that reaches every workspace the person is in (the default, #1079). `one_workspace`: one the
   * person limited to a single workspace (`approved`). `needs_reconnect`: its earlier approval no longer applies (made before approval
   * existed, or with the read-only level that was since removed), so the server refuses it until it is reconnected.
   * `this_workspace`: a token. No connection has an access level: every one is read and write.
   */
  reaches: 'all_workspaces' | 'one_workspace' | 'this_workspace' | 'needs_reconnect';
  /** `one_workspace` only; null otherwise. The name is null when it cannot be given. */
  approved?: { workspace_id: string; workspace_name: string | null } | null;
}

export const aiConnectionsKey = (ws: string) => ['ai-connections', ws] as const;

export function useAiConnections(ws: string, enabled = true) {
  return useQuery({
    enabled,
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

/**
 * Ticket #1187 — the state of one connection, from what the API reports and nothing more.
 *
 * The API says `needs_reconnect` when the connection has no valid approval (the guard then refuses it: "This AI connection has not
 * been approved. Reconnect the client and approve it when asked."). It does NOT say expired vs revoked: an OAuth connection whose
 * tokens have all expired, or that was revoked, is not listed at all, so that cause cannot be shown and is never invented here. A
 * `reaches` value this build does not know is `unknown`: no Reconnect is offered for a state we cannot name.
 */
export type ConnectionState =
  | { kind: 'connected' }
  | { kind: 'needs_reconnect'; reason: string }
  | { kind: 'unknown' };

/** What the data supports about WHY: the three causes the API documents for `needs_reconnect`, none of them guessed. */
export const NEEDS_RECONNECT_REASON =
  'It has no valid approval: it was connected before approval existed, was never approved, or was approved with the read-only level that has since been removed.';

export function connectionState(c: Pick<AiConnection, 'reaches'>): ConnectionState {
  switch (c.reaches) {
    case 'all_workspaces':
    case 'one_workspace':
    case 'this_workspace':
      return { kind: 'connected' };
    case 'needs_reconnect':
      return { kind: 'needs_reconnect', reason: NEEDS_RECONNECT_REASON };
    default:
      return { kind: 'unknown' };
  }
}

/** Which written guide / logo a connection belongs to, by the name it registered with; anything else is the generic one. */
export function clientFor(name: string): 'claude' | 'chatgpt' | 'other' {
  const n = name.toLowerCase();
  return n.includes('claude') ? 'claude' : n.includes('chatgpt') || n.includes('openai') ? 'chatgpt' : 'other';
}

/** The Reconnect action exists only for a connection the data says needs one. */
export function canReconnect(c: Pick<AiConnection, 'reaches'>): boolean {
  return connectionState(c).kind === 'needs_reconnect';
}

/** The summary in the box heading: "7 · 3 need reconnecting". */
export function aiAppsSummary(items: Array<Pick<AiConnection, 'reaches'>>): string {
  const n = items.filter(canReconnect).length;
  return n > 0 ? `${items.length} · ${n} need reconnecting` : `${items.length}`;
}

export interface ConnectionWords {
  how: string;
  reaches: string;
  confirmTitle: string;
  confirmMessage: string;
}

/** The words for one connection, in one place so the row and its confirmation can never describe different things. */
export function connectionWords(c: Pick<AiConnection, 'kind' | 'client_name' | 'reaches' | 'approved'>): ConnectionWords {
  const confirmTitle = `Disconnect ${c.client_name}?`;
  if (c.kind === 'token') {
    return {
      how: 'Personal access token',
      reaches: 'This workspace only',
      confirmTitle,
      confirmMessage: 'This token stops working right away. Anything still using it will start failing.',
    };
  }
  const how = 'Connected by signing in';
  if (c.reaches === 'all_workspaces') {
    return {
      how,
      reaches: 'All your workspaces',
      confirmTitle,
      confirmMessage: `${c.client_name} loses access to all your workspaces right away. It can ask to connect again, and you will be asked to allow it.`,
    };
  }
  if (c.reaches === 'one_workspace' && c.approved) {
    const where = c.approved.workspace_name ?? 'One workspace';
    return {
      how,
      reaches: `${where} only`,
      confirmTitle,
      confirmMessage: `${c.client_name} loses access to ${c.approved.workspace_name ?? 'its workspace'} right away. It can ask to connect again, and you will be asked to allow it.`,
    };
  }
  if (c.reaches === 'needs_reconnect') {
    // Its earlier approval no longer applies, so the server refuses it: shown as what it is, never as access it does not have.
    return {
      how,
      reaches: 'Reconnect needed',
      confirmTitle,
      confirmMessage: `${c.client_name} stops working until it is reconnected: its earlier approval no longer applies. Disconnecting removes it; connect it again to choose its workspaces.`,
    };
  }
  // A shape this page does not know (a newer or older server): say so rather than guess at access.
  return {
    how,
    reaches: 'Access not reported',
    confirmTitle,
    confirmMessage: `${c.client_name} loses access right away. It can ask to connect again, and you will be asked to allow it.`,
  };
}

/** What to print for "last used". Null is NOT the same fact for both kinds, and neither is rendered as a guess. */
export function lastUsedText(c: Pick<AiConnection, 'kind' | 'last_used_at'>, date: (v: unknown) => string): string {
  if (c.last_used_at) return `Last used ${date(c.last_used_at)}`;
  return c.kind === 'token' ? 'Never used' : 'Last use not recorded';
}
