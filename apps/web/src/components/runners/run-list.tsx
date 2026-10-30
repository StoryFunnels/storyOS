import Link from 'next/link';
import { describeRun, isFinishedRun } from '@/lib/runners/status';
import type { TimeOpts } from '@/lib/runners/words';
import type { WakeDto } from '@/lib/runners/types';
import { StatusMark } from './status-mark';

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
}: {
  ws: string;
  wakes: readonly WakeDto[];
  /** The API has more rows than this page: then no total is claimed. */
  more: boolean;
  loading?: boolean;
  error?: boolean;
  tz?: TimeOpts;
}) {
  const finished = wakes.filter(isFinishedRun).length;
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
        <p className="px-3.5 py-3 text-body text-muted">Nothing has woken this agent yet. When a record does, it shows here.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {wakes.map((w) => {
            const line = describeRun(w, tz);
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
