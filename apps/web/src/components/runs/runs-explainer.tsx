'use client';

import { BookOpen, ChevronRight, X } from 'lucide-react';
import { useDismissedHints } from '@/lib/dismissed-hints';

/** The stable key stored in the viewer's dismissed-hints list. Changing it would show the card again to everyone. */
export const RUNS_EXPLAINER_HINT = 'agent-runs-explainer';
export const RUNS_DOCS_URL = 'https://docs.storyos.dev/concepts/agent-runs/';

/**
 * #976 — "what is a run?". Copy matches THIS page's own terms (it lists automation rule runs; source syncs are not
 * in the list yet), so if that changes the copy changes in the same PR (AC4). The status words are the ones the
 * filter chips below use: OK, Failed, Skipped (quota).
 */
export function RunsExplainerCard({
  collapsed,
  onHide,
  onShow,
}: {
  collapsed: boolean;
  onHide: () => void;
  onShow: () => void;
}) {
  if (collapsed) {
    // A real link-styled button at rest, never revealed by hover (#900).
    return (
      <button
        type="button"
        onClick={onShow}
        className="mb-4 inline-flex items-center gap-1 text-label text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        <BookOpen className="h-3.5 w-3.5" /> What are agent runs?
      </button>
    );
  }
  return (
    <section
      aria-label="What are agent runs?"
      data-testid="runs-explainer"
      className="mb-5 rounded-[var(--radius-card)] border border-border-default bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-body font-semibold text-ink">What is a run?</h2>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this explanation"
          className="-mr-1 -mt-1 shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1 text-body text-muted">
        A run is one time an automation rule did its job: a record change, a schedule, or a button.
        Each row shows which rule, on which record, and how it ended.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-body text-muted">
        <li>
          <strong className="font-medium text-ink">Awaiting approval</strong> — an action is paused
          until someone approves it (open the run to see it).
        </li>
        <li>
          <strong className="font-medium text-ink">OK</strong> or{' '}
          <strong className="font-medium text-ink">Failed</strong> — how the run ended.
        </li>
        <li>
          <strong className="font-medium text-ink">Skipped (quota)</strong> — the workspace was out
          of runs for the month.
        </li>
      </ul>
      <a
        href={RUNS_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-0.5 text-label font-medium text-accent hover:underline"
      >
        Read more in the docs <ChevronRight className="h-3.5 w-3.5" />
      </a>
    </section>
  );
}

/** The card as the Runs page uses it: per-viewer, through the workspace's dismissed hints. */
export function RunsExplainer({ ws }: { ws: string }) {
  const hints = useDismissedHints(ws);
  // Nothing until the viewer's list is known, so a card someone hid never flashes open.
  if (hints.dismissed === undefined) return null;
  const collapsed = hints.dismissed.includes(RUNS_EXPLAINER_HINT);
  return (
    <RunsExplainerCard
      collapsed={collapsed}
      onHide={() => hints.setDismissed(RUNS_EXPLAINER_HINT, true)}
      onShow={() => hints.setDismissed(RUNS_EXPLAINER_HINT, false)}
    />
  );
}
