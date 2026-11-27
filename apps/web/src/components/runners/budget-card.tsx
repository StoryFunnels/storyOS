'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { plainProblem, readOnlyLine } from '@/lib/runners/agent-settings';
import {
  budgetDraft,
  countText,
  pausedLine,
  resetsLabel,
  resumesNowNote,
  runsView,
  tokensNote,
  tokensView,
  warningLine,
} from '@/lib/runners/budget';
import type { BudgetDto, BudgetMetricState, MetricView } from '@/lib/runners/budget';
import { cn } from '@/lib/utils';

const CHIP = 'rounded-[4px] border px-1.5 text-label font-medium';
const FILL: Record<BudgetMetricState, string> = {
  ok: 'bg-primary',
  warning: 'bg-warning',
  paused: 'bg-border-strong',
  unlimited: 'bg-primary',
  not_measured: 'bg-primary',
};

export type BudgetValues = { monthly_token_budget: number | null; monthly_run_cap: number | null };

/**
 * Ticket #1268 — the agent page's "Budget this month": what the agent may use, what it has used, and (for a manager) the way to
 * change it. A card of the run list's own chrome, between the facts and Advanced, `id="budget"` so a paused run row can link here.
 *
 * Every figure is the API's (see lib/runners/budget.ts). The card is drawn only when the API answered: a viewer it 404s gets no
 * card (the page does not mount this). Controls only for `canEdit` (the Agents database's write bar, same as Advanced); everyone
 * else reads the numbers and the one line saying who manages the agent. Warning is amber, paused is calm grey, never gold: gold is
 * an agent acting (#831), and a budget is a rule a person set.
 */
export function BudgetCard({
  status,
  budget,
  agentName,
  canEdit,
  ownerName,
  saving,
  onSave,
  onRetry,
}: {
  status: 'loading' | 'error' | 'ready';
  budget: BudgetDto | null;
  agentName: string;
  canEdit: boolean;
  /** The agent's manager by name, or null when the reader is that person or the name is unknown. */
  ownerName: string | null;
  saving: boolean;
  /** Resolves when the API accepted the write; rejects with the API's error. */
  onSave: (values: BudgetValues) => Promise<unknown>;
  onRetry: () => void;
}) {
  return (
    <section id="budget" className="scroll-mt-4 rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="agent-budget">
      <Header budget={status === 'ready' ? budget : null} />
      {status === 'loading' ? (
        <p role="status" className="m-0 px-3.5 py-3 text-body text-muted">
          Loading…
        </p>
      ) : status === 'error' || !budget ? (
        <p role="alert" className="m-0 px-3.5 py-3 text-body text-error">
          Couldn’t load {agentName}’s budget.{' '}
          <button type="button" className="font-medium text-primary-text underline" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : (
        <Body budget={budget} agentName={agentName} canEdit={canEdit} ownerName={ownerName} saving={saving} onSave={onSave} />
      )}
    </section>
  );
}

function Header({ budget }: { budget: BudgetDto | null }) {
  return (
    <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body font-[650] leading-[15px] text-ink">
      <h2 className="m-0 flex-1 text-body font-[650] leading-[15px]">Budget this month</h2>
      {budget?.state === 'warning' && (
        <span className={cn(CHIP, 'border-warning text-warning-text')} data-testid="budget-chip">
          Over 80%
        </span>
      )}
      {budget?.state === 'paused' && (
        <span className={cn(CHIP, 'border-border-default text-muted')} data-testid="budget-chip">
          Paused
        </span>
      )}
      {budget && <span className="text-label font-medium text-muted">{resetsLabel(budget.period.resets_at)}</span>}
    </div>
  );
}

function Metric({ label, view, note, warn }: { label: string; view: MetricView; note: string | null; warn: string | null }) {
  return (
    <div data-testid={`budget-${label.toLowerCase()}`} data-state={view.state}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-ink">{view.text}</span>
      </div>
      {view.barPercent !== null && (
        <div role="progressbar" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.barPercent} className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
          <div className={cn('h-full rounded-full', FILL[view.state])} style={{ width: `${view.barPercent}%` }} />
        </div>
      )}
      {warn && <p className="m-0 mt-1 text-label text-warning-text">{warn}</p>}
      {note && <p className="m-0 mt-1 text-label text-muted">{note}</p>}
    </div>
  );
}

function Body({ budget, agentName, canEdit, ownerName, saving, onSave }: { budget: BudgetDto; agentName: string; canEdit: boolean; ownerName: string | null; saving: boolean; onSave: (values: BudgetValues) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [runsText, setRunsText] = useState('');
  const [tokensText, setTokensText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const runs = runsView(budget.runs);
  const tokens = tokensView(budget.tokens);
  const paused = budget.state === 'paused';

  function open() {
    setRunsText(budget.limits.runs === null ? '' : String(budget.limits.runs));
    setTokensText(budget.limits.tokens === null ? '' : String(budget.limits.tokens));
    setProblem(null);
    setEditing(true);
  }

  const runsDraft = budgetDraft(runsText);
  const tokensDraft = budgetDraft(tokensText);
  const draftError = runsDraft.error ?? tokensDraft.error;
  const unchanged = runsDraft.value === budget.limits.runs && tokensDraft.value === budget.limits.tokens;

  async function save() {
    if (draftError || unchanged) return;
    setProblem(null);
    try {
      await onSave({ monthly_token_budget: tokensDraft.value, monthly_run_cap: runsDraft.value });
      setEditing(false);
    } catch (e) {
      // The API's own sentence wins over the screen's (it is the one that decides).
      setProblem(plainProblem(apiErrorMessage(e, 'Could not save the budget. Try again.')));
    }
  }

  if (budget.state === 'none' && !editing) {
    const tokenWords = budget.tokens.used === null ? 'tokens not reported' : `${budget.tokens.measurement === 'partial' ? 'at least ' : ''}${countText(budget.tokens.used)} tokens`;
    return (
      <div className="flex flex-col gap-2 px-3.5 py-3 text-body" data-testid="budget-none">
        <p className="m-0 text-ink">
          <b className="font-semibold">No budget.</b> {agentName} runs whenever its triggers fire. This month: {countText(budget.runs.used ?? 0)} {budget.runs.used === 1 ? 'run' : 'runs'}, {tokenWords}.
        </p>
        {canEdit ? (
          <div>
            <Button size="sm" variant="secondary" onClick={open}>
              Set a budget
            </Button>
          </div>
        ) : (
          <p className="m-0 text-label text-muted" data-testid="budget-read-only">
            {readOnlyLine(ownerName)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3 text-body">
      <Metric label="Runs" view={runs} note={null} warn={budget.runs.state === 'warning' && budget.runs.limit !== null ? warningLine(agentName, budget.runs.limit, budget.period.resets_at) : null} />
      <Metric label="Tokens" view={tokens} note={tokensNote(budget.tokens)} warn={budget.tokens.state === 'warning' && budget.tokens.limit !== null ? warningLine(agentName, budget.tokens.limit, budget.period.resets_at) : null} />
      {paused && (
        <p className="m-0 text-ink" data-testid="budget-paused">
          {pausedLine(agentName, budget)}
        </p>
      )}

      {editing ? (
        <form
          className="flex flex-col gap-2.5 border-t border-border-default pt-3"
          data-testid="budget-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-label text-muted">Runs a month</span>
              <Input autoFocus inputMode="numeric" value={runsText} onChange={(e) => setRunsText(e.target.value)} placeholder="No limit" aria-invalid={runsDraft.error ? true : undefined} className={cn('w-full', runsDraft.error && 'border-error')} data-testid="budget-runs-input" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label text-muted">Tokens a month</span>
              <Input inputMode="numeric" value={tokensText} onChange={(e) => setTokensText(e.target.value)} placeholder="No limit" aria-invalid={tokensDraft.error ? true : undefined} className={cn('w-full', tokensDraft.error && 'border-error')} data-testid="budget-tokens-input" />
            </label>
          </div>
          {(problem ?? draftError) ? (
            <p role="alert" className="m-0 text-label text-error" data-testid="budget-error">
              {problem ?? draftError}
            </p>
          ) : (
            <p className="m-0 text-label text-muted">
              Leave a box empty for no limit.{' '}
              {!unchanged && resumesNowNote(agentName, budget, { runs: runsDraft.value, tokens: tokensDraft.value })}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={Boolean(draftError) || unchanged || saving}>
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : canEdit ? (
        <div>
          <Button size="sm" variant={paused ? 'primary' : 'secondary'} onClick={open}>
            {paused ? 'Raise budget' : 'Change budget'}
          </Button>
        </div>
      ) : (
        <p className="m-0 text-label text-muted" data-testid="budget-read-only">
          {readOnlyLine(ownerName)}
        </p>
      )}
    </div>
  );
}
