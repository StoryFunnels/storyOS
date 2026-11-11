import Link from 'next/link';
import { describeRun, isFinishedRun } from '@/lib/runners/status';
import type { TimeOpts } from '@/lib/runners/words';
import type { WakeDto } from '@/lib/runners/types';
import { StatusMark } from './status-mark';
import { Quill, QuillBeside } from '@/components/quill/quill';
import { firstSuccessfulRunId, runQuill } from '@/lib/quill/run-outcome';

/**
 * Ticket #1139 AC5 — an agent's runs, one row each, the state exactly as drawn.
 *
 * Every row's state is the server's `run_state` (ADR-0021 §11), rendered by `describeRun`. Gold appears on a running row and on
 * a row waiting for approval and nowhere else here. A failed row carries NO "Try again" button: no endpoint re-queues a failed
 * wake (the ticket names this gap), and a button that does nothing is worse than none.
 */
export function RunList({
  ws,
  wakes,
  more,
  loading,
  error,
  tz,
  masked = false,
}: {
  ws: string;
  wakes: readonly WakeDto[];
  /** The API has more rows than this page: then no total is claimed. */
  more: boolean;
  loading?: boolean;
  error?: boolean;
  tz?: TimeOpts;
  /** The viewer may not be told machine or tool names (a guest). */
  masked?: boolean;
}) {
  const finished = wakes.filter(isFinishedRun).length;
  // #1253 — Quill celebrates the agent's FIRST success only, and only when this list holds its whole history.
  const firstSuccess = firstSuccessfulRunId(wakes, more);
  return (
    <section className="rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="run-list">
      <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body font-[650] leading-[15px] text-ink">
        <span className="flex-1">Runs</span>
        {!loading && !error && (
          <span className="text-label font-medium text-muted">{more ? `Latest ${wakes.length}` : `${finished} finished so far`}</span>
        )}
      </div>
      {loading ? (
        <p role="status" className="px-3.5 py-3 text-body text-muted">
          Loading…
        </p>
      ) : error ? (
        <p role="alert" className="px-3.5 py-3 text-body text-error">
          Could not load this agent’s runs. Try again in a moment.
        </p>
      ) : wakes.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 px-4 py-[18px] text-center" data-testid="runs-empty">
          <p className="m-0 text-body text-muted">No runs yet. They show up here when an agent wakes.</p>
          <Quill pose="ready" size={56} caption="Yes, chef." />
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {wakes.map((w) => {
            const line = describeRun(w, { ...tz, masked });
            const href = w.record?.database_id ? `/w/${ws}/d/${w.record.database_id}/r/${w.record.id}` : null;
            const title = w.record?.title || (w.record ? 'Untitled' : 'No record');
            return (
              <li key={w.id} className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default px-3.5 py-2 first:border-t-0">
                <span className="flex min-w-[180px] flex-1 flex-col leading-[1.35]">
                  {href ? (
                    <Link href={href} className="truncate text-body font-medium leading-[1.35] text-ink hover:underline">
                      {title}
                    </Link>
                  ) : (
                    <b className="truncate text-body font-medium leading-[1.35] text-ink">{title}</b>
                  )}
                  {line.sub && <span className="text-label leading-[1.35] text-muted">{line.sub}</span>}
                </span>
                <StatusMark tone={line.tone}>{line.label}</StatusMark>
                {line.action === 'review' && (
                  <Link
                    href={`/w/${ws}/runs`}
                    className="inline-flex h-7 items-center rounded-[var(--radius-control)] bg-primary px-2.5 text-body font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
                  >
                    Review
                  </Link>
                )}
                {/* After the pill and the action, never before them: the real state and what to do about it come first. */}
                {(() => {
                  const q = runQuill(w, firstSuccess);
                  return q ? <QuillBeside pose={q.pose} caption={q.caption} /> : null;
                })()}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
