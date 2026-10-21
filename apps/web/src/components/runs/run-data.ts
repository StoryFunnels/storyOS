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

/** Runs, newest first. The status filter is applied CLIENT-side against the effective status (see `effectiveRunStatus`),
 *  because "Awaiting approval" is not a status the API stores. The search is the API's own (matches the record's title). */
export function useRunsList(ws: string, q: string) {
  return useQuery({
    queryKey: ['runs', ws, q],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs', {
        params: { path: { ws }, query: { q: q || undefined, limit: 100 } },
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

/** The approvals list endpoint caps at this many rows and returns no total (apps/api approvals.service `limit: 100`). */
export const APPROVALS_PAGE_LIMIT = 100;

/**
 * Which runs are waiting for a person: the run id of every PENDING approval. The API closes a run as `ok` once its
 * actions are queued, so this is the only way to tell (ticket #1009 asks for a real status). `capped` means the list hit
 * its page limit, so the count is "at least" — printing it bare would be a confident wrong number.
 */
export function usePendingApprovalRuns(ws: string) {
  return useQuery({
    queryKey: ['approvals', ws, 'pending-runs'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals', {
        params: { path: { ws }, query: { status: 'pending' } },
      } as never);
      if (error) throw error;
      const rows = data as unknown as Array<{ run_id: string | null }>;
      return {
        runIds: new Set(rows.map((r) => r.run_id).filter((id): id is string => Boolean(id))),
        count: rows.length,
        capped: rows.length >= APPROVALS_PAGE_LIMIT,
      };
    },
    refetchInterval: 15_000,
  });
}
