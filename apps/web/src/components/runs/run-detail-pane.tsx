'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, History, Rocket } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useDatabases } from '@/lib/queries';
import { ApprovalGate } from '@/components/approvals/use-approval-view';
import { useResolveApproval } from '@/components/inbox-panel';
import {
  actionKindLabel,
  effectiveRunStatus,
  formatDuration,
  runStepSummary,
  startedLabel,
  stepStateWord,
} from '@/lib/run-labels';
import { cn } from '@/lib/utils';
import { RunStatusPill } from './run-status-pill';
import { useRunDetail } from './run-data';
import type { RunAction } from './run-data';

const STEP_WORD_TONE: Record<string, string> = {
  failed: 'font-bold text-error',
  'waiting for you': 'font-bold text-accent-text',
};

/**
 * #997 — the right-hand pane of the runs page (the prototype's `runDetail()`): Back and Run again, the rule's name,
 * who triggered it, the numbered steps, the error, the approval card WITH its buttons, and collapsed technical details.
 *
 * Everything the old dialog showed is still here: each step's attempts, last error, artifact and idempotency detail sit
 * under "Technical details", where it was already collapsed per step.
 */
export function RunDetailPane({
  ws,
  runId,
  pendingRunIds,
  onBack,
}: {
  ws: string;
  runId: string;
  pendingRunIds: ReadonlySet<string>;
  onBack: () => void;
}) {
  const fmt = useDateFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const detail = useRunDetail(ws, runId);
  const databases = useDatabases(ws);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['run-detail', ws, runId] });
    void qc.invalidateQueries({ queryKey: ['runs', ws] });
  };

  // "Run again" is the failed-step re-run the API has (POST /runs/:id/actions/:index/rerun); there is no whole-run
  // re-run (ticket #1009), so the button exists exactly when a step failed, and re-runs those steps.
  const rerun = useMutation({
    mutationFn: async (indexes: number[]) => {
      for (const index of indexes) {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/runs/{id}/actions/{index}/rerun', {
          params: { path: { ws, id: runId, index } },
        } as never);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Re-run queued');
      refresh();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not re-run this action')),
  });
  const resolve = useResolveApproval(ws, refresh);

  if (detail.isLoading) return <p className="text-body text-muted">Loading…</p>;
  if (!detail.data) return <p className="text-body text-error">This run could not be loaded.</p>;
  const run = detail.data;
  const status = effectiveRunStatus(run.status, run.id, pendingRunIds);
  const dbName = databases.data?.find((d) => d.id === run.database_id)?.name;
  const failed = run.actions.filter((a) => a.status === 'failed');
  const now = new Date();

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All runs
        </button>
        <span className="flex-1" />
        {failed.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={rerun.isPending}
            onClick={async () => {
              if (
                !(await confirm({
                  title: failed.length > 1 ? 'Run the failed steps again?' : 'Run this step again?',
                  message: 'This runs the failed step again using the same information as the first attempt.',
                  confirmLabel: 'Run again',
                }))
              )
                return;
              rerun.mutate(failed.map((a) => a.action_index));
            }}
          >
            <History className="h-3 w-3" /> Run again
          </Button>
        )}
      </div>

      <h2 className="m-0 mb-1 flex flex-wrap items-center gap-2 text-[18px] font-bold leading-snug tracking-[-0.01em] text-ink">
        {run.name ?? '(deleted rule)'}
        <RunStatusPill status={status} />
      </h2>
      <p className="m-0 text-body text-muted">
        Triggered by: automation “{run.name ?? 'deleted rule'}”{dbName ? ` on ${dbName}` : ''} ·{' '}
        {startedLabel(run.started_at, now, fmt.date)}
        {run.duration_ms !== null && ` · took ${formatDuration(run.duration_ms)}`}
        {run.record_ref && (
          <>
            {' '}
            · <span className="text-ink">{run.record_ref.title || 'Untitled record'}</span>
          </>
        )}
      </p>

      {run.actions.length > 0 ? (
        <ol className="my-3.5 list-decimal pl-5 text-prose">
          {run.actions.map((action) => (
            <li key={action.action_index} className="py-[5px]">
              {runStepSummaryName(action)}
              <em
                className={cn(
                  'ml-2 text-micro not-italic text-faint',
                  STEP_WORD_TONE[stepStateWord(action.status)],
                )}
              >
                {stepStateWord(action.status)}
                {action.status === 'failed' && action.attempts > 1 ? ` after ${action.attempts} tries` : ''}
              </em>
            </li>
          ))}
        </ol>
      ) : (
        <p className="my-3.5 text-body text-muted">No external actions were queued for this run.</p>
      )}

      {run.error && (
        <p className="mb-3 rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,var(--card))] px-3 py-[9px] text-label text-ink">
          {run.error}
        </p>
      )}
      {failed.some((a) => a.last_error) && (
        <p className="mb-3 rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,var(--card))] px-3 py-[9px] text-label text-ink">
          A step didn’t go through. The exact error is under Technical details.
        </p>
      )}

      {run.actions
        .filter((a) => a.approval)
        .map((a) => (
          <ApprovalCard
            key={a.approval!.id}
            ws={ws}
            ruleName={run.name ?? 'Automation'}
            approval={a.approval!}
            startedAt={run.started_at}
            busy={resolve.isPending}
            onDecide={(verdict) => resolve.mutate({ approvalId: a.approval!.id, verdict })}
          />
        ))}

      <details className="mt-3.5 text-label text-muted">
        <summary className="cursor-pointer font-semibold">Technical details</summary>
        <div className="mt-2 flex flex-col gap-2">
          <code className="font-mono text-[11px]">
            run_id: {run.id}
            {run.trigger ? ` · trigger: ${run.trigger.type}` : ''}
            {run.duration_ms !== null ? ` · ${run.duration_ms} ms` : ''}
          </code>
          {run.actions.map((action) => (
            <StepTechnical key={action.action_index} action={action} />
          ))}
        </div>
      </details>
    </div>
  );
}

/** The step's plain-words name: "Email", "Webhook", or the approval's own preview when it has no kind yet. */
function runStepSummaryName(action: RunAction): string {
  if (action.kind) return actionKindLabel(action.kind);
  return action.approval?.preview_text ?? runStepSummary({ kind: null, status: action.status });
}

function StepTechnical({ action }: { action: RunAction }) {
  const hasDetail =
    Boolean(action.last_error) ||
    (action.artifact !== null && action.artifact !== undefined) ||
    Boolean(action.connection_id) ||
    Boolean(action.idempotency_key);
  return (
    <div className="rounded-[var(--radius-control)] border border-border-default p-2">
      <p className="text-meta text-faint">
        Step {action.action_index + 1}: <span className="text-muted">{actionKindLabel(action.kind)}</span>
        {action.kind ? ` (${action.kind})` : ''} · status {action.status} · {action.attempts} attempt(s)
        {action.connection_id ? ` · connection ${action.connection_id}` : ''}
        {action.idempotency_key ? ` · key ${action.idempotency_key}` : ''}
      </p>
      {hasDetail && action.last_error && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-hover p-2 text-meta text-error">{action.last_error}</pre>
      )}
      {action.artifact !== null && action.artifact !== undefined && (
        <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-hover p-2 text-meta text-muted">
          {JSON.stringify(action.artifact, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * The prototype's `approvalCard()`: the rule, when it asked, what it wants to do, Reject / Approve. The buttons are
 * live only while the approval is actually waiting (`ApprovalGate`, the Inbox's own gate); a decided one reads
 * "Approved." / "Rejected." with who and when.
 */
function ApprovalCard({
  ws,
  ruleName,
  approval,
  startedAt,
  busy,
  onDecide,
}: {
  ws: string;
  ruleName: string;
  approval: NonNullable<RunAction['approval']>;
  startedAt: string;
  busy: boolean;
  onDecide: (verdict: 'approve' | 'reject') => void;
}) {
  const fmt = useDateFormat();
  const [now] = useState(() => new Date());
  return (
    <div className="mt-3 rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--accent)_45%,var(--border-default))] bg-[color-mix(in_srgb,var(--accent)_6%,var(--card))] p-3">
      <div className="flex items-center gap-[7px] text-label">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] text-accent-text">
          <Rocket className="h-3 w-3" aria-hidden />
        </span>
        <b className="font-semibold text-ink">{ruleName}</b>
        <span className="ml-auto text-micro text-faint">{startedLabel(startedAt, now, fmt.date)}</span>
      </div>
      <p className="mb-0.5 mt-1.5 text-body font-semibold text-ink">{approval.preview_text}</p>
      <ApprovalGate ws={ws} approvalId={approval.id}>
        <div className="mt-[9px] flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('reject')}>
            Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onDecide('approve')}>
            Approve
          </Button>
        </div>
      </ApprovalGate>
    </div>
  );
}
