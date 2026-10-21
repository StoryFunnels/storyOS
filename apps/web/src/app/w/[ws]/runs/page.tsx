'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { useDateFormat } from '@/lib/preferences';
import { cn } from '@/lib/utils';
import { RunsExplainer } from '@/components/runs/runs-explainer';
import { RunDetailPane } from '@/components/runs/run-detail-pane';
import { RunStatusPill } from '@/components/runs/run-status-pill';
import { usePendingApprovalCount, useQuota, useRunsList } from '@/components/runs/run-data';
import { formatDurationShort, RUN_STATUS_FILTERS, startedLabel } from '@/lib/run-labels';

/**
 * Automation runs (#997, built to the prototype's `runsPage()` / `runDetail()`; first shipped as MN-264).
 *
 * A master–detail split: the list is 560px and the selected run fills the rest; under 900px of page width the detail
 * REPLACES the list (the detail's own "← All runs" brings it back). The header's subtitle is only the quota line, from
 * the real `/runs/quota` endpoint. The one hideable explainer (#976) sits under it; the gold bar says how many runs
 * are waiting for a person.
 *
 * Every row is a rule run — source syncs are not in this list yet, and the page does not say so in prose any more
 * (that sentence, and an internal ticket id inside it, were the page explaining itself a third time).
 */
export default function RunsPage() {
  const { ws } = useParams<{ ws: string }>();
  const fmt = useDateFormat();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runs = useRunsList(ws, status, q);
  const quota = useQuota(ws);
  const waitingCount = usePendingApprovalCount(ws);
  const rows = runs.data ?? [];
  const now = new Date();
  const waiting = waitingCount.data ?? 0;

  return (
    <div className="@container flex h-full min-h-0">
      <div
        className={cn(
          'min-w-0 flex-none overflow-auto py-5 pb-10 @min-[900px]:w-[560px] @min-[900px]:border-r @min-[900px]:border-border-default',
          selectedRunId ? 'hidden @min-[900px]:block' : 'w-full',
        )}
      >
        <header className="mx-5 mb-3">
          <h1 className="m-0 text-[22px] font-bold leading-tight tracking-[-0.01em] text-ink">Automation runs</h1>
          {quota.data && (
            <p className="mt-1 text-body text-muted">
              {quota.data.limit === null ? (
                <>
                  <b className="font-semibold text-ink">{quota.data.used.toLocaleString()}</b> runs this month · unlimited
                  plan
                </>
              ) : (
                <>
                  Runs this month: <b className="font-semibold text-ink">{quota.data.used.toLocaleString()}</b> of{' '}
                  {quota.data.limit.toLocaleString()}
                  {quota.data.projected !== null && quota.data.projected > quota.data.limit && (
                    <span className="ml-1 text-warning">(on pace for ~{quota.data.projected.toLocaleString()})</span>
                  )}
                </>
              )}
            </p>
          )}
        </header>

        <div className="mx-5">
          <RunsExplainer ws={ws} />
        </div>

        {waiting > 0 && (
          <div className="mx-5 mb-3 flex items-center gap-2 rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--accent)_35%,var(--border-default))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--card))] px-2.5 py-2 text-body text-ink">
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-micro font-bold tabular-nums text-on-accent">
              {waiting}
            </span>
            {waiting} waiting for your approval — nothing happens until you say so.
          </div>
        )}

        <div className="mx-5 mb-2.5 flex gap-2">
          <Input
            placeholder="Search by item title…"
            aria-label="Search runs by item title"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1"
          />
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-[34px] rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-label text-ink"
          >
            {RUN_STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mx-5 grid grid-cols-[1fr_130px_80px_64px] items-center gap-2.5 border-b border-border-default py-1.5 text-meta font-semibold text-muted max-[600px]:grid-cols-[1fr_110px] max-[600px]:[&>span:nth-child(n+3)]:hidden">
          <span>Rule / item</span>
          <span>Status</span>
          <span>Started</span>
          <span>Duration</span>
        </div>
        {runs.isLoading && <p className="px-5 py-6 text-body text-muted">Loading…</p>}
        {!runs.isLoading && rows.length === 0 && (
          <p className="px-5 py-6 text-body text-muted">No runs match these filters.</p>
        )}
        {rows.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => setSelectedRunId(run.id)}
            className={cn(
              'grid w-full grid-cols-[1fr_130px_80px_64px] items-center gap-2.5 border-b border-border-default px-5 py-[9px] text-left text-label hover:bg-hover max-[600px]:grid-cols-[1fr_110px] max-[600px]:[&>span:nth-child(n+3)]:hidden',
              run.id === selectedRunId && 'bg-active',
            )}
          >
            <span className="flex min-w-0 flex-col">
              <b className="truncate font-semibold text-ink">{run.name ?? '(deleted rule)'}</b>
              <i className="truncate not-italic text-muted">
                {run.record_ref
                  ? `${run.record_ref.number !== null ? `#${run.record_ref.number} ` : ''}${run.record_ref.title || 'Untitled'}`
                  : '—'}
              </i>
            </span>
            <span>
              <RunStatusPill status={run.status} />
            </span>
            <span className="whitespace-nowrap text-muted">{startedLabel(run.started_at, now, fmt.date)}</span>
            <span className="whitespace-nowrap text-muted">{formatDurationShort(run.duration_ms)}</span>
          </button>
        ))}
      </div>

      <div
        className={cn(
          'min-w-0 flex-1 overflow-auto px-7 py-[22px] pb-[60px]',
          selectedRunId ? '' : 'hidden @min-[900px]:block',
        )}
      >
        {selectedRunId ? (
          <RunDetailPane
            key={selectedRunId}
            ws={ws}
            runId={selectedRunId}
            onBack={() => setSelectedRunId(null)}
            onOpenRun={setSelectedRunId}
          />
        ) : (
          <p className="pt-10 text-center text-body text-muted">Pick a run to see each step.</p>
        )}
      </div>
    </div>
  );
}

