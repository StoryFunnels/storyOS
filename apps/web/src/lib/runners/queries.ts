'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useDatabases, useWorkspace } from '@/lib/queries';
import { canUseRunners } from './access';
import { agentSystemDatabases } from '@/lib/system-databases';
import { useDatabase } from '@/components/table-view/use-table-data';
import { toAgentView } from './agents';
import type { AgentRecordLike, AgentView } from './agents';
import type { AssignmentDto, PairingCodeIssued, PairingPoll, RunnerDto, WakeDto, WakeSummary } from './types';

/**
 * Ticket #1139 — every Runner read and write the screens make, on the REAL endpoints (ADR-0021 §11). No fake data lives here:
 * the paths are `apps/api/src/runners/runners.controller.ts` and `agent-wakes.controller.ts`, and a call the API refuses
 * surfaces the API's own sentence (a guest, a token, an expired pairing window).
 *
 * The generated SDK types its paths but not the 200 bodies, so each call casts through `unknown` to the hand-typed shapes in
 * `types.ts`, the pattern this app already uses for responses without an OpenAPI schema.
 */
function unwrap<T>({ data, error }: { data?: unknown; error?: unknown }): T {
  if (error) throw error;
  return data as T;
}

export const runnerKeys = {
  runners: (ws: string) => ['runners', ws] as const,
  summary: (ws: string) => ['agent-wakes-summary', ws] as const,
  wakes: (ws: string, agent: string) => ['agent-wakes', ws, agent] as const,
  agents: (ws: string) => ['runner-agents', ws] as const,
};

/** The signed-in person's id: who "my Runners" and "my agents" mean. Undefined while the session loads. */
export function useMyUserId(): string | undefined {
  return useSession().data?.user?.id;
}

/** The viewer's OWN Runners (never anyone else's, admins included). A guest holds none and the API refuses them, so `enabled` is the caller's. */
export function useRunners(ws: string, enabled = true) {
  // A guest holds no Runner and the API refuses them (403): never ask. The role is the one `useWorkspace` already has cached.
  const allowed = canUseRunners(useWorkspace(ws).data?.role);
  return useQuery({
    queryKey: runnerKeys.runners(ws),
    queryFn: async () =>
      unwrap<RunnerDto[] | { data: RunnerDto[] }>(await api.GET('/api/v1/workspaces/{ws}/runners', { params: { path: { ws } } } as never)),
    select: (body) => (Array.isArray(body) ? body : body.data),
    enabled: enabled && allowed,
    // The status line says "checked a minute ago": poll so it moves while the page is open.
    refetchInterval: 20_000,
  });
}

/** Waiting counts per agent and in total, filtered server-side by what the viewer may read. Drives the sidebar number and the first-time moment. */
export function useWakeSummary(ws: string, enabled = true) {
  return useQuery({
    queryKey: runnerKeys.summary(ws),
    queryFn: async () => unwrap<WakeSummary>(await api.GET('/api/v1/workspaces/{ws}/agent-wakes/summary', { params: { path: { ws } } } as never)),
    enabled,
    refetchInterval: 30_000,
  });
}

/** The queue for one agent, newest first, each row carrying the server-derived `run_state`. */
export function useAgentWakes(ws: string, agentId: string | undefined) {
  return useQuery({
    queryKey: runnerKeys.wakes(ws, agentId ?? ''),
    queryFn: async () =>
      unwrap<{ data: WakeDto[]; next_cursor: string | null }>(
        await api.GET('/api/v1/workspaces/{ws}/agent-wakes', { params: { path: { ws }, query: { agent: agentId, limit: 50 } } } as never),
      ),
    enabled: Boolean(agentId),
    refetchInterval: 10_000,
  });
}

export function useAssignment(ws: string, agentId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['runner-assignment', ws, agentId],
    queryFn: async () =>
      unwrap<AssignmentDto>(await api.GET('/api/v1/workspaces/{ws}/runner-assignments/{agent}', { params: { path: { ws, agent: agentId! } } } as never)),
    enabled: enabled && Boolean(agentId),
  });
}

interface RecordList {
  data: AgentRecordLike[];
}

/** Every agent the viewer can read, from the Agents system database (an agent IS a record there). `loading` until both the list and its fields are known. */
export function useAgents(ws: string): { agents: AgentView[]; dbId: string | null; loading: boolean; error: boolean } {
  const dbs = useDatabases(ws);
  const agentsDb = agentSystemDatabases(dbs.data ?? []).agents;
  const detail = useDatabase(ws, agentsDb?.id ?? '');
  const rows = useQuery({
    queryKey: runnerKeys.agents(ws),
    queryFn: async () =>
      unwrap<RecordList>(await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', { params: { path: { ws, db: agentsDb!.id }, query: { limit: 100 } } } as never)),
    enabled: Boolean(agentsDb),
  });
  const fields = (detail.data?.fields ?? []) as Array<{ apiName: string; options?: Array<{ id: string; label: string }> }>;
  const agents = (rows.data?.data ?? []).map((r) => toAgentView(r, fields));
  return {
    agents,
    dbId: agentsDb?.id ?? null,
    loading: dbs.isPending || (Boolean(agentsDb) && (rows.isPending || detail.isPending)),
    error: dbs.isError || rows.isError || detail.isError,
  };
}

export function useRunnerMutations(ws: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: runnerKeys.runners(ws) });
    void qc.invalidateQueries({ queryKey: runnerKeys.summary(ws) });
    void qc.invalidateQueries({ queryKey: ['runner-assignment', ws] });
    void qc.invalidateQueries({ queryKey: ['agent-wakes', ws] });
  };
  return {
    issueCode: useMutation({
      mutationFn: async () => unwrap<PairingCodeIssued>(await api.POST('/api/v1/workspaces/{ws}/runners/pairing-codes', { params: { path: { ws } } } as never)),
    }),
    cancelCode: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/runners/pairing-codes/{id}', { params: { path: { ws, id } } } as never);
        if (error) throw error;
      },
      onSuccess: refresh,
    }),
    activate: useMutation({
      mutationFn: async ({ id, tool }: { id: string; tool: string }) =>
        unwrap<RunnerDto>(await api.POST('/api/v1/workspaces/{ws}/runners/{id}/activate', { params: { path: { ws, id } }, body: { tool } } as never)),
      onSuccess: refresh,
    }),
    setTool: useMutation({
      mutationFn: async ({ id, tool }: { id: string; tool: string }) =>
        unwrap<RunnerDto>(await api.PATCH('/api/v1/workspaces/{ws}/runners/{id}', { params: { path: { ws, id } }, body: { tool } } as never)),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/runners/{id}', { params: { path: { ws, id } } } as never);
        if (error) throw error;
      },
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: async ({ agentId, runnerId }: { agentId: string; runnerId: string | null }) =>
        unwrap<AssignmentDto>(
          await api.PUT('/api/v1/workspaces/{ws}/runner-assignments/{agent}', { params: { path: { ws, agent: agentId } }, body: { runner_id: runnerId } } as never),
        ),
      onSuccess: refresh,
    }),
  };
}

/** One poll of a pairing code. Not a hook: the pairing card owns the timer so it can stop it the moment the state says so. */
export async function pollPairingCode(ws: string, id: string): Promise<PairingPoll> {
  return unwrap<PairingPoll>(await api.GET('/api/v1/workspaces/{ws}/runners/pairing-codes/{id}', { params: { path: { ws, id } } } as never));
}
