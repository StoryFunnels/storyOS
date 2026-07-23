'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface RunSummary {
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

interface RunAction {
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

interface RunDetail extends RunSummary {
  trigger: { type: string } | null;
  condition: unknown;
  depth: number;
  effects: unknown;
  actions: RunAction[];
}

interface QuotaSummary {
  used: number;
  limit: number | null;
  projected: number | null;
}

const STATUS_FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Failed' },
  { value: 'skipped_quota', label: 'Skipped (quota)' },
  { value: 'skipped', label: 'Skipped (other)' },
  { value: 'running', label: 'Running' },
] as const;

function statusDotClass(status: string): string {
  if (status === 'ok') return 'bg-success';
  if (status === 'error') return 'bg-error';
  if (status === 'running') return 'bg-accent';
  return 'bg-warning'; // skipped / skipped_quota
}

function useRunsList(ws: string, status: string | undefined, q: string) {
  return useQuery({
    queryKey: ['runs', ws, status, q],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs', {
        params: { path: { ws }, query: { status, q: q || undefined, limit: 100 } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: RunSummary[] }).data;
    },
    refetchInterval: 15_000,
  });
}

function useQuota(ws: string) {
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

function useRunDetail(ws: string, runId: string | null) {
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
 * MN-264 — one page to see every automation run and answer "why didn't my
 * post go out?" NARROWED SCOPE: every row is a rule run — source syncs
 * (MN-260/#239) aren't unioned in yet (see runs.service.ts's own doc); the
 * `kind=source` filter is wired but returns nothing until #239 ships.
 */
export default function RunsPage() {
  const { ws } = useParams<{ ws: string }>();
  const fmt = useDateFormat();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [q, setQ] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runs = useRunsList(ws, status, q);
  const quota = useQuota(ws);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-1 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-ink">Runs</h1>
        {quota.data && (
          <div className="text-right text-[12px] text-muted">
            {quota.data.limit === null ? (
              <span>{quota.data.used} automation runs this month · unlimited plan</span>
            ) : (
              <span>
                Runs this month: <strong className="text-ink">{quota.data.used}</strong> / {quota.data.limit}
                {quota.data.projected !== null && quota.data.projected > quota.data.limit && (
                  <span className="ml-1 text-warning">(on pace for ~{quota.data.projected})</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="mb-6 text-[13px] text-muted">
        Every automation rule run in this workspace, newest first. Source syncs (MN-260) will join this
        list once that ships — for now this is rule runs only.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setStatus(f.value)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[12px]',
              status === f.value
                ? 'border-[var(--primary)] bg-accent-soft text-ink'
                : 'border-border-default text-muted hover:bg-hover',
            )}
          >
            {f.label}
          </button>
        ))}
        <Input
          placeholder="Search by record title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="ml-auto max-w-[220px]"
        />
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b border-border-default px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          <span>Rule / record</span>
          <span>Status</span>
          <span>Started</span>
          <span>Duration</span>
        </div>
        {runs.isLoading && <p className="px-4 py-6 text-[13px] text-muted">Loading…</p>}
        {!runs.isLoading && (runs.data ?? []).length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">No runs match these filters.</p>
        )}
        {(runs.data ?? []).map((run) => (
          <button
            key={run.id}
            onClick={() => setSelectedRunId(run.id)}
            className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border-default px-4 py-2.5 text-left last:border-b-0 hover:bg-hover"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{run.name ?? '(deleted rule)'}</p>
              <p className="truncate text-[12px] text-muted">
                {run.trigger_kind ?? '—'}
                {run.record_ref ? ` · ${run.record_ref.title || 'Untitled'}` : ''}
                {run.action_summary.length > 0 &&
                  ` · ${run.action_summary.map((a) => `${a.kind}:${a.status}`).join(', ')}`}
              </p>
            </div>
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full', statusDotClass(run.status))} />
              {run.status}
            </span>
            <span className="whitespace-nowrap text-[12px] text-muted">{fmt.dateTime(run.started_at)}</span>
            <span className="whitespace-nowrap text-[12px] text-muted">
              {run.duration_ms !== null ? `${run.duration_ms}ms` : '—'}
            </span>
          </button>
        ))}
      </div>

      <RunDetailDialog ws={ws} runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
    </div>
  );
}

function RunDetailDialog({ ws, runId, onClose }: { ws: string; runId: string | null; onClose: () => void }) {
  const fmt = useDateFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const detail = useRunDetail(ws, runId);

  const rerun = useMutation({
    mutationFn: async (actionIndex: number) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/runs/{id}/actions/{index}/rerun', {
        params: { path: { ws, id: runId, index: actionIndex } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Re-run queued');
      void qc.invalidateQueries({ queryKey: ['run-detail', ws, runId] });
      void qc.invalidateQueries({ queryKey: ['runs', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not re-run this action')),
  });

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(open) => !open && onClose()}>
      {runId && (
        <DialogContent title={detail.data?.name ?? 'Run detail'} className="max-w-2xl">
          {detail.isLoading && <p className="text-[13px] text-muted">Loading…</p>}
          {detail.data && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2 text-[13px]">
                <span className={cn('inline-block h-2 w-2 rounded-full', statusDotClass(detail.data.status))} />
                <span className="font-medium text-ink">{detail.data.status}</span>
                <span className="text-muted">· {fmt.dateTime(detail.data.started_at)}</span>
                {detail.data.duration_ms !== null && <span className="text-muted">· {detail.data.duration_ms}ms</span>}
              </div>
              {detail.data.error && (
                <p className="rounded bg-hover px-2 py-1.5 text-[12px] text-error">{detail.data.error}</p>
              )}
              {detail.data.record_ref && (
                <p className="text-[12px] text-muted">
                  Triggered by: <span className="text-ink">{detail.data.record_ref.title || 'Untitled record'}</span>
                </p>
              )}

              <div>
                <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">
                  Actions ({detail.data.actions.length})
                </h3>
                {detail.data.actions.length === 0 && (
                  <p className="text-[12px] text-faint">No external actions were queued for this run.</p>
                )}
                <div className="flex flex-col gap-2">
                  {detail.data.actions.map((action) => (
                    <div key={action.action_index} className="rounded-[var(--radius-card)] border border-border-default p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', statusDotClass(action.status === 'pending_approval' ? 'skipped' : action.status))} />
                          {action.kind ?? action.approval?.preview_text ?? 'gated action'}
                          <span className="font-normal text-muted">· {action.status}</span>
                          {action.attempts > 0 && <span className="font-normal text-faint">· {action.attempts} attempt(s)</span>}
                        </span>
                        {action.status === 'failed' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={rerun.isPending}
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: 'Re-run this action?',
                                  message: 'Runs again with the exact same frozen inputs from the original attempt.',
                                  confirmLabel: 'Re-run',
                                }))
                              )
                                return;
                              rerun.mutate(action.action_index);
                            }}
                          >
                            Re-run
                          </Button>
                        )}
                      </div>
                      {action.last_error && (
                        <pre className="mt-1.5 overflow-x-auto rounded bg-hover p-2 text-[11px] text-error">{action.last_error}</pre>
                      )}
                      {action.artifact !== null && action.artifact !== undefined && (
                        <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-hover p-2 text-[11px] text-muted">
                          {JSON.stringify(action.artifact, null, 2)}
                        </pre>
                      )}
                      {action.approval && (
                        <p className="mt-1.5 text-[11px] text-muted">
                          Approval: {action.approval.status}
                          {action.approval.decided_by ? ` by ${action.approval.decided_by}` : ''}
                          {action.approval.decided_at ? ` · ${fmt.dateTime(action.approval.decided_at)}` : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
