'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { boxBody, boxButton, boxTitle, DIALOG_CANCEL, DIALOG_STARTING, dialogAsks, dialogButton, dialogJob, dialogRunsLine, dialogTitle, scopeRow } from '@/lib/runners/catch-up-copy';
import { startsNow } from '@/lib/runners/catch-up';
import type { RunsLineInput, ScopeWords } from '@/lib/runners/catch-up';

/** What the muted "N runs on <machine> with <tool>" line needs, except N (it is `startsNow(count)`). */
export type CatchUpRuns = Omit<RunsLineInput, 'n'>;

/**
 * Ticket #1152 — "N clients already waiting", under "Runs on" on the agent page (the prototype's `.catchup`), and the
 * confirmation behind its button (`.cu`).
 *
 * The count is the API's own (`catch_up`), passed in; the box is drawn only for a positive one (the caller decides, with
 * `catchUpCount` and `offersCatchUp`). "Not now" closes the dialog and keeps the box: there is no dismiss-forever, the records
 * really are waiting. The start button is disabled while the click is in flight, and a refusal (an agent switched off, an owner who
 * left) is shown in the dialog in the API's own sentence, with the dialog left open.
 */
export function CatchUpBox({
  agentName,
  count,
  words,
  job,
  asksPhrases,
  runs,
  pending,
  error,
  onOpen,
  onStart,
}: {
  agentName: string;
  count: number;
  words: ScopeWords;
  job: string;
  asksPhrases: readonly string[];
  runs: CatchUpRuns;
  pending: boolean;
  /** The refusal sentence from the last click, or null. */
  error: string | null;
  /** Called as the dialog opens, so a refusal from an earlier try is not shown again. */
  onOpen: () => void;
  /** Resolves true when the click went through (the dialog then closes), false when it was refused (it stays open). */
  onStart: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);

  async function start() {
    if (pending) return;
    if (await onStart()) setOpen(false);
  }

  return (
    <>
      <section
        aria-label={boxTitle(count, words)}
        data-testid="catch-up"
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-border-strong bg-card px-3.5 py-3"
      >
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <h3 className="m-0 text-body font-semibold text-ink">{boxTitle(count, words)}</h3>
          <p className="m-0 text-body leading-[1.45] text-ink-secondary">{boxBody(count, agentName, words)}</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onOpen();
            setOpen(true);
          }}
          data-testid="catch-up-open"
        >
          {boxButton(count, words)}
        </Button>
      </section>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent title={dialogTitle(count, agentName, words)}>
          <CatchUpDialogBody
            agentName={agentName}
            count={count}
            words={words}
            job={job}
            asksPhrases={asksPhrases}
            runs={runs}
            pending={pending}
            error={error}
            onCancel={() => setOpen(false)}
            onStart={() => void start()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The dialog's contents, apart from the shell, so a static render can assert on what is drawn (pending, a refusal). */
export function CatchUpDialogBody({
  agentName,
  count,
  words,
  job,
  asksPhrases,
  runs,
  pending,
  error,
  onCancel,
  onStart,
}: {
  agentName: string;
  count: number;
  words: ScopeWords;
  job: string;
  asksPhrases: readonly string[];
  runs: CatchUpRuns;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: () => void;
}) {
  const row = scopeRow(count, words);
  const asks = dialogAsks(asksPhrases);
  return (
    <div data-testid="catch-up-dialog">
      {row && (
        <ul className="mb-3 list-none rounded-[var(--radius-control)] border border-border-default p-0">
          <li className="flex justify-between gap-2 px-2.5 py-[7px] text-body text-ink">
            <span>{row.left}</span>
            <span className="text-label text-muted">{row.right}</span>
          </li>
        </ul>
      )}
      <p className="m-0 mb-2 text-body leading-[1.5] text-ink-secondary">{dialogJob(count, agentName, words, job)}</p>
      {asks && <p className="m-0 mb-2 text-body leading-[1.5] text-ink-secondary">{asks}</p>}
      <p className="m-0 mb-4 text-label leading-[1.5] text-muted" data-testid="catch-up-runs">
        {dialogRunsLine({ ...runs, n: startsNow(count) })}
      </p>
      {error && (
        <p role="alert" className="m-0 mb-3 text-body text-error" data-testid="catch-up-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          {DIALOG_CANCEL}
        </Button>
        <Button type="button" size="sm" autoFocus onClick={onStart} disabled={pending} data-testid="catch-up-start">
          {pending ? DIALOG_STARTING : dialogButton(count, words)}
        </Button>
      </div>
    </div>
  );
}
