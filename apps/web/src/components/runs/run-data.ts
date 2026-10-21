'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The row the runs list returns (GET /runs). */
export interface RunSummary {
  id: string;
  kind: 'rule' | 'source';
  name: string | null;
  rule_id: string;
  database_id: string;
  trigger_kind: string | null;
  record_ref: { id: string; title: string | null; number: number | null } | null;
  status: string;
  error: string | null;
  started_at: string;
  duration_ms: number | null;
  action_summary: { kind: string; status: string }[];
}

export interface RunAction {
  action_index: number;
  kind: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  artifact: unknown;
  connection_id: string | null;
  idempotency_key: string | null;
  approval: { id: string; status: string; decided_by: string | null; decided_at: string | null; preview_text: string } | null;
}

export interface RunDetail extends RunSummary {
  trigger: { type: string } | null;
  condition: unknown;
  depth: number;
  effects: unknown;
  actions: RunAction[];
}

export interface QuotaSummary {
  used: number;
  limit: number | null;
  projected: number | null;
}

/** Runs, newest first. Both the status filter (`awaiting_approval` is derived by the API, ticket #1009) and the search
 *  (it matches the trigger record's title) are the API's own. */
export function useRunsList(ws: string, status: string, q: string) {
  return useQuery({
    queryKey: ['runs', ws, status, q],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs', {
        params: { path: { ws }, query: { status: status || undefined, q: q || undefined, limit: 100 } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: RunSummary[] }).data;
    },
    refetchInterval: 15_000,
  });
}

export function useQuota(ws: string) {
  return useQuery({
    queryKey: ['runs-quota', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs/quota', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as QuotaSummary;
    },
    refetchInterval: 60_000,
  });
}

export function useRunDetail(ws: string, runId: string | null) {
  return useQuery({
    queryKey: ['run-detail', ws, runId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs/{id}', {
        params: { path: { ws, id: runId } },
      } as never);
      if (error) throw error;
      return data as unknown as RunDetail;
    },
    enabled: Boolean(runId),
  });
}

/**
 * How many approvals are waiting for a person: the API's exact count (`GET /approvals/count`, ticket #1009), which agrees
 * with the scope the approvals list applies. It replaces counting a list that is capped at 100.
 */
export function usePendingApprovalCount(ws: string) {
  return useQuery({
    queryKey: ['approvals', ws, 'pending-count'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals/count' as never, {
        params: { path: { ws }, query: { status: 'pending' } },
      } as never);
      if (error) throw error;
      return (data as unknown as { total: number }).total;
    },
    refetchInterval: 15_000,
  });
}
