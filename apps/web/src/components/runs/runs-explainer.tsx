'use client';

import { ArrowRight, BookOpen, X } from 'lucide-react';
import { useDismissedHints } from '@/lib/dismissed-hints';

/** The stable key stored in the viewer's dismissed-hints list. Changing it would show the card again to everyone. */
export const RUNS_EXPLAINER_HINT = 'agent-runs-explainer';
/** #997 — `concepts/agent-runs` describes the Agentic OS Runs DATABASE, not this list. Until a docs page covers
 *  automation runs (Docs Task #692), the card links the automations concept. */
export const RUNS_DOCS_URL = 'https://docs.storyos.dev/concepts/automations/';

/**
 * #976 / #997 — "What is an automation run?". Copy matches THIS page's own terms; its status words are the page's
 * one vocabulary (`run-labels.ts`): Awaiting approval, Succeeded, Failed, Skipped (quota). The docs link is a plain
 * link, not gold: gold means agency (#831) and gold text fails contrast.
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
        <BookOpen className="h-3.5 w-3.5" /> What is an automation run?
      </button>
    );
  }
  return (
    <section
      aria-label="What is an automation run?"
      data-testid="runs-explainer"
      className="mb-5 rounded-[var(--radius-card)] border border-border-default bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-body font-semibold text-ink">What is an automation run?</h2>
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
        A run is one time an automation rule did its job — it starts when a record changes, on a schedule, or when
        you press a button. Every row here is one run: which rule, on which record, and how it ended.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-body text-muted">
        <li>
          <strong className="font-medium text-ink">Awaiting approval</strong> — the rule wants to change something
          and is waiting for you. Nothing happens until you approve; you can also do it from your Inbox.
        </li>
        <li>
          <strong className="font-medium text-ink">Succeeded</strong> /{' '}
          <strong className="font-medium text-ink">Failed</strong> — open a run to see each step it took, and the
          error if it failed.
        </li>
        <li>
          <strong className="font-medium text-ink">Skipped (quota)</strong> — your plan’s monthly runs were used
          up, so it didn’t run.
        </li>
      </ul>
      <a
        href={RUNS_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-0.5 text-label font-medium text-ink underline underline-offset-2 hover:no-underline"
      >
        How automations work <ArrowRight className="h-3.5 w-3.5" />
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
