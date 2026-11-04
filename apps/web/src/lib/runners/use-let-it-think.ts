'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { agentSystemDatabases } from '@/lib/system-databases';
import { useDatabase } from '@/components/table-view/use-table-data';
import type { EffectiveRole } from '@/lib/access';
import { aiModeOptionId, letItThink } from './let-it-think';
import type { NON_AI, OWN_AI } from './let-it-think';
import { runnerKeys } from './queries';
import type { AssignmentDto } from './types';

/**
 * Ticket #1210 — the two writes behind "Let it think with your AI" and "Run now", on the real endpoints:
 * the agent's own record (`PATCH .../databases/{db}/records/{rec}`, the same write the Agents table makes) for the AI mode, the
 * runner-assignments route for the preselected Runner, and `POST .../agents/{agent}/run` for a manual wake.
 *
 * The Agents database's detail is read through `useDatabase`, which `useAgents` already holds in the same cache entry, so this
 * adds no request: it only reads the option ids of "AI mode" and the viewer's own access to that database.
 */
function unwrap<T>({ data, error }: { data?: unknown; error?: unknown }): T {
  if (error) throw error;
  return data as T;
}

export function useAgentsDatabaseAccess(ws: string): {
  dbId: string | null;
  myAccess: EffectiveRole | undefined;
  optionId: (label: typeof OWN_AI | typeof NON_AI) => string | null;
} {
  const dbs = useDatabases(ws);
  const agentsDb = agentSystemDatabases(dbs.data ?? []).agents;
  const detail = useDatabase(ws, agentsDb?.id ?? '');
  const fields = (detail.data?.fields ?? []) as Array<{ apiName: string; options?: Array<{ id: string; label: string }> }>;
  return {
    dbId: agentsDb?.id ?? null,
    myAccess: detail.data?.my_access,
    optionId: (label) => aiModeOptionId(fields, label),
  };
}

export function useSetAiMode(ws: string, dbId: string | null) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: runnerKeys.agents(ws) });
    void qc.invalidateQueries({ queryKey: runnerKeys.summary(ws) });
    void qc.invalidateQueries({ queryKey: runnerKeys.runners(ws) });
    void qc.invalidateQueries({ queryKey: ['runner-assignment', ws] });
  };
  const write = async (agentId: string, optionId: string) =>
    unwrap<unknown>(await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', { params: { path: { ws, db: dbId!, rec: agentId } }, body: { values: { ai_mode: optionId } } } as never));
  return {
    /** Non-AI to Your own AI, then the preselected Runner (when there is exactly one online). */
    letItThink: useMutation({
      mutationFn: ({ agentId, ownAiOptionId, preselect }: { agentId: string; ownAiOptionId: string; preselect: { id: string; name: string } | null }) =>
        letItThink(
          {
            setMode: (id) => write(agentId, id),
            assign: async (runnerId) =>
              unwrap<AssignmentDto>(await api.PUT('/api/v1/workspaces/{ws}/runner-assignments/{agent}', { params: { path: { ws, agent: agentId } }, body: { runner_id: runnerId } } as never)),
          },
          ownAiOptionId,
          preselect,
        ),
      onSettled: refresh,
    }),
    /** Back to Non-AI (the entry point is the agent's Advanced section, ticket #1180). */
    switchBack: useMutation({
      mutationFn: ({ agentId, nonAiOptionId }: { agentId: string; nonAiOptionId: string }) => write(agentId, nonAiOptionId),
      onSettled: refresh,
    }),
  };
}

/** A manual wake: one POST. The server coalesces a repeat into the same Run, so a second click cannot make a second wake. */
export function useRunNow(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => unwrap<unknown>(await api.POST('/api/v1/workspaces/{ws}/agents/{agent}/run', { params: { path: { ws, agent: agentId } } } as never)),
    // Returned, not fired and forgotten: the mutation stays pending until the queue has been re-read, so the button cannot be
    // pressed again in the gap between "queued" and "the page knows it is queued" (where it would look idle).
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['agent-wakes', ws] }), qc.invalidateQueries({ queryKey: runnerKeys.summary(ws) })]),
  });
}
