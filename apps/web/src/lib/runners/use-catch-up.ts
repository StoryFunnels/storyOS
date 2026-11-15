'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { agentSystemDatabases } from '@/lib/system-databases';
import { databaseQuery, useDatabase } from '@/components/table-view/use-table-data';
import { GENERIC_SCOPE, scopeWords, triggerScope } from './catch-up';
import type { ScopeWords, TriggerBindingLike } from './catch-up';
import { runnerKeys } from './queries';
import type { CatchUpResult } from './types';

/**
 * Ticket #1152 — the reads and the one write behind the catch-up box, on the real endpoints:
 *  - the COUNT is `catch_up` in `agent-wakes/summary` (already read by `useWakeSummary`, which refetches on focus and every 30 s);
 *  - the WORDS (which database, which state) come from the agent's own trigger bindings, read as records of the Agent Triggers
 *    system database and the trigger database's detail: both existing endpoints, neither a new one;
 *  - the click is `POST .../agents/{agent}/catch-up`, session only, no body.
 */
function unwrap<T>({ data, error }: { data?: unknown; error?: unknown }): T {
  if (error) throw error;
  return data as T;
}

interface DatabaseRef {
  id: string;
  name: string;
  isSystem?: boolean;
}

/** Every binding in the Agent Triggers database, fetched once per workspace (the box filters by agent). */
export async function fetchBindings(ws: string, triggersDbId: string): Promise<TriggerBindingLike[]> {
  const body = unwrap<{ data: TriggerBindingLike[] }>(
    await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', { params: { path: { ws, db: triggersDbId }, query: { limit: 100 } } } as never),
  );
  return body.data;
}

export const bindingsKey = (ws: string, dbId: string) => ['agent-trigger-bindings', ws, dbId] as const;

/**
 * The noun and state the copy uses for this agent. While anything is still loading, or if a read fails (a viewer who cannot read the
 * Triggers database, a deleted field), the answer is the plain `record` / "its trigger state": the box still shows, it just
 * names less. Nothing here can hide the box or change the count.
 */
export function useCatchUpScope(ws: string, agentId: string, enabled: boolean): ScopeWords {
  const dbs = useDatabases(ws, enabled);
  const triggersDb = agentSystemDatabases((dbs.data ?? []) as DatabaseRef[])['agent triggers'];
  const bindings = useQuery({
    queryKey: bindingsKey(ws, triggersDb?.id ?? ''),
    queryFn: () => fetchBindings(ws, triggersDb!.id),
    enabled: enabled && Boolean(triggersDb),
    staleTime: 30_000,
  });
  const scope = bindings.data ? triggerScope(bindings.data, agentId) : null;
  const target = useDatabase(ws, enabled && scope ? scope.databaseId : '');
  return scopeWords(scope, target.data);
}

/**
 * The same words, fetched imperatively, for the Done toast (which fires outside any component that could hold the hooks). Returns
 * the plain words on any failure: a toast must not fail because a name could not be read.
 */
export async function fetchCatchUpScope(qc: QueryClient, ws: string, agentId: string): Promise<ScopeWords> {
  try {
    const dbs = await qc.fetchQuery({
      queryKey: ['databases', ws],
      queryFn: async () => unwrap<DatabaseRef[]>(await api.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws } } })),
      staleTime: 10_000,
    });
    const triggersDb = agentSystemDatabases(dbs)['agent triggers'];
    if (!triggersDb) return GENERIC_SCOPE;
    const bindings = await qc.fetchQuery({ queryKey: bindingsKey(ws, triggersDb.id), queryFn: () => fetchBindings(ws, triggersDb.id), staleTime: 0 });
    const scope = triggerScope(bindings, agentId);
    if (!scope) return GENERIC_SCOPE;
    const detail = await qc.fetchQuery({ ...databaseQuery(ws, scope.databaseId), staleTime: 10_000 });
    return scopeWords(scope, detail);
  } catch {
    return GENERIC_SCOPE;
  }
}

/**
 * The click, as mutation options (a function so a test can run it without React). After it settles, whatever the outcome, the
 * summary is re-read, so the box shows the server's number now, not the one from before the click; and the queue, which now has
 * the new wakes.
 */
export function catchUpMutationOptions(qc: QueryClient, ws: string) {
  return {
    mutationFn: async (agentId: string) =>
      unwrap<CatchUpResult>(await api.POST('/api/v1/workspaces/{ws}/agents/{agent}/catch-up', { params: { path: { ws, agent: agentId } } } as never)),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: runnerKeys.summary(ws) }),qc.invalidateQueries({ queryKey: ['agent-wakes', ws] })]),
  };
}

/** The mutation's own `isPending` is what disables the buttons: a second click cannot be sent while one is in flight. */
export function useCatchUp(ws: string) {
  const qc = useQueryClient();
  return useMutation(catchUpMutationOptions(qc, ws));
}
