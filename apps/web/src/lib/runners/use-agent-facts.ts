'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { agentSystemDatabases } from '@/lib/system-databases';
import { databaseQuery } from '@/components/table-view/use-table-data';
import { bindingsKey, fetchBindings } from './use-catch-up';
import { triggerDatabaseIds, wakeLines } from './wake-facts';
import type { AgentScopeDto, DbLookup, WakeLine } from './wake-facts';

/**
 * Ticket #1289 — the reads behind the agent page's "Wakes when" and "Works in" rows. Both are admin-only on the server (the
 * agents controller is `@MinRole('admin')`), so `enabled` is false for everyone else and nothing is asked: the page hides the
 * rows for them rather than claim "nothing configured".
 *
 *  - Works in: `GET /workspaces/{ws}/agents/{agent}/scope`, resolved by the server now. The SDK types this response as empty, so
 *    the shape is `AgentScopeDto` here and the call casts through `unknown`.
 *  - Wakes when: the agent's records in the Agent Triggers system database (the same read the catch-up box makes), with each
 *    trigger database's detail for its words. A database missing from the workspace's list is a deleted one.
 */
interface DatabaseRef {
  id: string;
  name: string;
  isSystem?: boolean;
}

export type FactsState<T> = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; value: T };

export function useAgentScope(ws: string, agentId: string, enabled: boolean): FactsState<AgentScopeDto> {
  const q = useQuery({
    queryKey: ['agent-scope', ws, agentId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents/{agent}/scope', { params: { path: { ws, agent: agentId } } } as never);
      if (error) throw error;
      return data as unknown as AgentScopeDto;
    },
    enabled: enabled && Boolean(ws && agentId),
    staleTime: 15_000,
    retry: false,
  });
  if (q.isError) return { status: 'failed' };
  if (q.data) return { status: 'ready', value: q.data };
  return { status: 'loading' };
}

export function useAgentWakeLines(ws: string, agentId: string, enabled: boolean): FactsState<WakeLine[]> {
  const dbs = useDatabases(ws, enabled);
  const list = (dbs.data ?? []) as DatabaseRef[];
  const triggersDb = agentSystemDatabases(list)['agent triggers'];
  const bindings = useQuery({
    queryKey: bindingsKey(ws, triggersDb?.id ?? ''),
    queryFn: () => fetchBindings(ws, triggersDb!.id),
    enabled: enabled && Boolean(triggersDb),
    staleTime: 30_000,
    retry: false,
  });
  const wanted = bindings.data ? triggerDatabaseIds(bindings.data, agentId) : [];
  // A database that is not in the workspace's list is deleted: no detail is asked for it.
  const alive = wanted.filter((id) => list.some((d) => d.id === id));
  const details = useQueries({ queries: alive.map((id) => ({ ...databaseQuery(ws, id), enabled, staleTime: 30_000 })) });

  if (dbs.isError || bindings.isError) return { status: 'failed' };
  // No Agent Triggers database at all (the list loaded and has none): the agent has no trigger of its own.
  if (dbs.data && !triggersDb) return { status: 'ready', value: [] };
  if (!bindings.data || details.some((d) => d.isPending)) return { status: 'loading' };
  const lookup = (id: string): DbLookup | undefined => {
    if (!list.some((d) => d.id === id)) return { kind: 'deleted' };
    const i = alive.indexOf(id);
    const detail = details[i]?.data;
    return detail ? { kind: 'ok', db: detail } : undefined;
  };
  return { status: 'ready', value: wakeLines(bindings.data, agentId, lookup) };
}
