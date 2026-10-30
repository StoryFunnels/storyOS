'use client';

import { Check, Copy, Loader2 } from 'lucide-react';
import { useEffect, useReducer, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { apiErrorMessage } from '@/lib/api';
import {
  canPressDone,
  codeAriaLabel,
  displayCode,
  expiredCopy,
  pairingReducer,
  pairingStart,
  pickableTools,
  shouldPoll,
} from '@/lib/runners/pairing';
import type { PairingState } from '@/lib/runners/pairing';
import { pollPairingCode, useRunnerMutations } from '@/lib/runners/queries';
import { COPY, toolName } from '@/lib/runners/words';
import { cn } from '@/lib/utils';

const POLL_MS = 2_000;

/**
 * Ticket #1139 AC2 — "Add a Runner", three steps, against the REAL pairing API (ADR-0021 §3).
 *
 * No password and no pasted token: step 1 is one command, step 2 is the server's own 6-character single-use code (the Runner
 * asks the person to type it), step 3 turns from "Waiting for your computer…" to "connected" the moment the server says the code
 * was exchanged, then the choice between the tools the Runner FOUND. Nothing here decides that pairing worked; it follows the
 * poll (`pairing.ts`). Done is the call that turns the Runner on, and the sentence beside it says what happens before it.
 */
export function PairingCard({
  ws,
  onCancel,
  onDone,
}: {
  ws: string;
  onCancel: () => void;
  /** The Runner is ON (the server accepted Done). */
  onDone: (done: { runnerId: string; runnerName: string; tool: string }) => void;
}) {
  const [state, dispatch] = useReducer(pairingReducer, pairingStart);
  const m = useRunnerMutations(ws);
  const issued = useRef(false);
  const stateRef = useRef<PairingState>(state);
  stateRef.current = state;

  // Issue ONE code per mount. A new code burns the person's previous unused one, so React's dev double-mount must not issue two.
  useEffect(() => {
    if (issued.current) return;
    issued.current = true;
    // `mutateAsync`, not `mutate(..., {onSuccess})`: React's dev double-mount re-subscribes the mutation observer, which drops
    // per-call callbacks and would leave the card on "Getting your code…" forever.
    m.issueCode.mutateAsync().then(
      (code) => dispatch({ type: 'issued', code }),
      (e) => dispatch({ type: 'issue_failed', message: apiErrorMessage(e, 'Could not get a pairing code. Try again in a moment.') }),
    );
  }, []);

  // Poll while the answer can still change; stop the moment it cannot.
  const codeId = 'codeId' in state ? state.codeId : null;
  const polling = shouldPoll(state);
  useEffect(() => {
    if (!polling || !codeId) return;
    let stop = false;
    const tick = async () => {
      try {
        const poll = await pollPairingCode(ws, codeId);
        if (!stop) dispatch({ type: 'polled', poll });
      } catch {
        // A blip is not an answer: keep the current state and ask again.
      }
    };
    const t = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [polling, codeId, ws]);

  function cancel() {
    const s = stateRef.current;
    dispatch({ type: 'cancel' });
    // Cancel burns the code AND revokes the Runner it produced, server-side, so a half-paired computer is not left behind.
    if ('codeId' in s) m.cancelCode.mutate(s.codeId);
    onCancel();
  }

  function press() {
    if (state.phase !== 'connected' || !state.tool) return;
    const { runner, tool } = state;
    dispatch({ type: 'activate' });
    m.activate.mutateAsync({ id: runner.id, tool }).then(
      () => {
        dispatch({ type: 'activated', runnerId: runner.id, runnerName: runner.name, tool });
        onDone({ runnerId: runner.id, runnerName: runner.name, tool });
      },
      (e) => {
        const code = (e as { error?: { code?: string } })?.error?.code;
        dispatch({ type: 'activate_failed', message: apiErrorMessage(e, 'Could not turn it on. Try again.'), expired: code === 'pairing_expired' });
      },
    );
  }

  const connected = state.phase === 'connected' || state.phase === 'activating' || state.phase === 'done';

  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="pairing-card" data-phase={state.phase}>
      <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body font-[650] text-ink">
        <span className="flex-1">Add a Runner</span>
        <button type="button" className="text-label font-semibold text-primary-text hover:underline" onClick={cancel}>
          Cancel
        </button>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        {state.phase === 'expired' || state.phase === 'cancelled' || state.phase === 'failed' ? (
          <div className="flex flex-col items-start gap-2.5" role="status">
            <p className="text-body text-ink-secondary">
              {state.phase === 'failed' ? state.message : state.phase === 'cancelled' ? 'Pairing was cancelled.' : expiredCopy()}
            </p>
            <Button size="sm" onClick={onCancel}>
              Start again
            </Button>
          </div>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
            <Step n={1} ok={connected}>
              <span>
                On the computer where <b className="font-semibold text-ink">Claude Code or Cursor</b> is signed in, open Terminal and run:
              </span>
              <Command />
            </Step>
            <Step n={2} ok={connected}>
              <span>When it asks for a code, type:</span>
              {state.phase === 'issuing' ? (
                <p className="py-1.5 text-label text-muted" role="status">
                  Getting your code…
                </p>
              ) : (
                <div
                  className="pt-1.5 font-mono text-[22px] font-semibold tracking-[0.18em] text-ink sm:text-[26px]"
                  aria-label={'code' in state ? codeAriaLabel(state.code) : undefined}
                  data-testid="pairing-code"
                >
                  {'code' in state ? displayCode(state.code) : ''}
                </div>
              )}
              <span className="text-label text-muted">{COPY.codeNote}</span>
            </Step>
            <Step n={3} ok={connected}>
              {state.phase === 'connected' || state.phase === 'activating' ? (
                <ConnectedStep state={state} onChoose={(tool) => dispatch({ type: 'choose_tool', tool })} onDone={press} />
              ) : state.phase === 'done' ? (
                <b className="font-semibold text-ink">{state.runnerName} is ready.</b>
              ) : (
                <span className="inline-flex items-center gap-2 text-label text-muted" role="status">
                  <i aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-border-strong border-t-primary-text motion-safe:animate-spin" />
                  Waiting for your computer…
                </span>
              )}
            </Step>
          </ol>
        )}
      </div>
    </div>
  );
}

function Step({ n, ok, children }: { n: number; ok: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[24px_1fr] gap-2.5 text-body text-ink-secondary">
      <span
        aria-hidden
        className={cn(
          'flex h-[22px] w-[22px] items-center justify-center rounded-full text-label font-bold',
          ok ? 'bg-[color-mix(in_srgb,var(--success)_16%,var(--bg-card))] text-success' : 'bg-hover text-ink',
        )}
      >
        {ok ? <Check className="h-3 w-3" strokeWidth={3} /> : n}
      </span>
      <span className="flex min-w-0 flex-col gap-1">{children}</span>
    </li>
  );
}

function Command() {
  return (
    <div className="mt-1.5 flex h-[34px] max-w-[360px] items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-app pl-2.5 pr-1 font-mono text-[12px] text-ink">
      <span className="flex-1 overflow-x-auto whitespace-nowrap">{COPY.command}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={`Copy ${COPY.command}`}
        onClick={() => {
          navigator.clipboard.writeText(COPY.command).then(
            () => toast.success('Copied'),
            () => toast.error('Could not copy. Select the command and copy it.'),
          );
        }}
      >
        <Copy className="h-3 w-3" aria-hidden />
        Copy
      </Button>
    </div>
  );
}

function ConnectedStep({
  state,
  onChoose,
  onDone,
}: {
  state: Extract<PairingState, { phase: 'connected' | 'activating' }>;
  onChoose: (tool: string) => void;
  onDone: () => void;
}) {
  const tools = pickableTools(state.runner.tools);
  const busy = state.phase === 'activating';
  const found = tools.map((t) => toolName(t.id, state.runner.tools));
  return (
    <>
      <span>
        <b className="font-semibold text-ink">{state.runner.name} is connected.</b>{' '}
        {tools.length === 0
          ? 'It did not find Claude Code or Cursor on that computer. Sign in to one of them there, then add the Runner again.'
          : `It found ${found.length === 1 ? found[0] : `${found.slice(0, -1).join(', ')} and ${found[found.length - 1]}`}. Which should your agents use?`}
      </span>
      {tools.length > 1 && (
        <Segmented
          label="Which tool your agents use"
          className="mt-2"
          value={state.tool ?? tools[0]!.id}
          onChange={onChoose}
          options={tools.map((t) => ({ value: t.id, label: toolName(t.id, state.runner.tools) }))}
        />
      )}
      {'error' in state && state.error && (
        <p className="mt-1 text-label text-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <Button type="button" size="sm" disabled={busy || !canPressDone(state as PairingState)} onClick={onDone}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
          Done
        </Button>
        <span className="text-label text-muted">{COPY.doneSentence}</span>
      </div>
    </>
  );
}
