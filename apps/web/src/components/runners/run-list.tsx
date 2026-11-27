import Link from 'next/link';
import { describeRun, isFinishedRun } from '@/lib/runners/status';
import type { TimeOpts } from '@/lib/runners/words';
import type { WakeDto } from '@/lib/runners/types';
import { StatusMark } from './status-mark';
import { Quill, QuillBeside } from '@/components/quill/quill';
import { EmptyState } from '@/components/ui/empty-state';
import { firstSuccessfulRunId, runQuill } from '@/lib/quill/run-outcome';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Lock } from 'lucide-react';
import { RUNS_HIDDEN_HEADER, limitedEmptyBody, limitedEmptyTitle } from '@/lib/runners/visibility';
import { itemTitle, NOT_STARTED_LABEL, notStartedSub, notStartedTail } from '@/lib/runners/catch-up-list';
import type { WaitingList } from '@/lib/runners/catch-up-list';
import type { ScopeWords } from '@/lib/runners/catch-up';

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
  limited = false,
  agentName = 'This agent',
  notStarted = null,
  notStartedWords = null,
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
  /**
   * Ticket #1276 — the API says some of this agent's runs are hidden from the viewer. Then no total is drawn (not "N finished", not
   * "Latest N"), the empty state says the activity is hidden rather than "No runs yet", and nothing is celebrated as the first run.
   */
  limited?: boolean;
  agentName?: string;
  /**
   * Ticket #1224: the records waiting in the trigger state that catch-up has not queued yet, one grey "Not started" row each. Null
   * (a guest, a refusal, a failed read) draws nothing. The rows go when the click queues them: the list is re-read after it.
   */
  notStarted?: WaitingList | null;
  notStartedWords?: ScopeWords | null;
}) {
  const waitingRows = notStarted?.items ?? [];
  const tail = notStarted && notStartedWords ? notStartedTail(notStarted, waitingRows.length, notStartedWords) : [];
  const hasWaiting = waitingRows.length > 0 || tail.length > 0;
  const finished = wakes.filter(isFinishedRun).length;
  // #1253 — Quill celebrates the agent's FIRST success only, and only when this list holds its whole history.
  const firstSuccess = firstSuccessfulRunId(wakes, more || limited);
  return (
    <section className="rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="run-list">
      <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body font-[650] leading-[15px] text-ink">
        <span className="flex-1">Runs</span>
        {!loading && !error && (
          <span className="text-label font-medium text-muted">
            {limited ? RUNS_HIDDEN_HEADER : more ? `Latest ${wakes.length}` : `${finished} finished so far`}
          </span>
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
      ) : wakes.length === 0 && !hasWaiting && limited ? (
        <EmptyState
          variant="big"
          className="m-3 w-auto max-w-none"
          data-testid="runs-limited"
          icon={<Lock className="h-6 w-6" />}
          title={limitedEmptyTitle(agentName)}
          body={limitedEmptyBody(agentName)}
        />
      ) : wakes.length === 0 && !hasWaiting ? (
        <EmptyState
          variant="big"
          className="m-3 w-auto max-w-none"
          data-testid="runs-empty"
          quill={<Quill pose="ready" size={56} caption="Yes, chef." />}
          title="No runs yet"
          body="They show up here when an agent wakes."
        />
      ) : (
        <ul className="m-0 list-none p-0">
          {waitingRows.map((it) => (
            <RunRowFrame
              key={`waiting-${it.id}`}
              testId="not-started-row"
              title={itemTitle(it)}
              href={`/w/${ws}/d/${it.database_id}/r/${it.id}`}
              sub={notStartedWords ? notStartedSub(notStartedWords) : null}
            >
              <StatusMark tone="off">{NOT_STARTED_LABEL}</StatusMark>
            </RunRowFrame>
          ))}
          {tail.map((t) => (
            <li key={t} data-testid="not-started-tail" className="flex min-h-[46px] items-center border-t border-border-default px-3.5 py-2 text-label text-muted first:border-t-0">
              {t}
            </li>
          ))}
          {wakes.map((w) => {
            const line = describeRun(w, { ...tz, masked });
            const href = w.record?.database_id ? `/w/${ws}/d/${w.record.database_id}/r/${w.record.id}` : null;
            const title = w.record?.title || (w.record ? 'Untitled' : 'No record');
            return (
              <RunRowFrame key={w.id} title={title} href={href} sub={line.sub}>
                <StatusMark tone={line.tone}>{line.label}</StatusMark>
                {line.action === 'review' && (
                  <Link
                    href={`/w/${ws}/runs`}
                    className={cn(buttonVariants({ variant: 'primary' }))}
                  >
                    Review
                  </Link>
                )}
                {/* After the pill and the action, never before them: the real state and what to do about it come first. */}
                {(() => {
                  const q = runQuill(w, firstSuccess);
                  return q ? <QuillBeside pose={q.pose} caption={q.caption} /> : null;
                })()}
              </RunRowFrame>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** One row of the list, whatever it is: a real run or a record not started yet. The one place the row's chrome is drawn. */
function RunRowFrame({ title, href, sub, testId, children }: { title: string; href: string | null; sub: string | null; testId?: string; children: React.ReactNode }) {
  return (
    <li data-testid={testId} className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default px-3.5 py-2 first:border-t-0">
      <span className="flex min-w-[180px] flex-1 flex-col leading-[1.35]">
        {href ? (
          <Link href={href} className="truncate text-body font-medium leading-[1.35] text-ink hover:underline">
            {title}
          </Link>
        ) : (
          <b className="truncate text-body font-medium leading-[1.35] text-ink">{title}</b>
        )}
        {sub && <span className="text-label leading-[1.35] text-muted">{sub}</span>}
      </span>
      {children}
    </li>
  );
}
