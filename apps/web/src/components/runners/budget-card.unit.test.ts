import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BudgetDto } from '@/lib/runners/budget';
import type { RunStateName, WakeDto } from '@/lib/runners/types';
import { readOnlyLine } from '@/lib/runners/agent-settings';
import { BudgetCard } from './budget-card';
import { RunList } from './run-list';

/**
 * Ticket #1268 — the card in every state the API can put it in, for a manager and for a reader. A guest with a grant on Agents and
 * Runs reads it read-only; a viewer the API 404s never gets the card (the page does not mount it), which the page test below pins.
 */
const base = (over: Partial<BudgetDto> = {}): BudgetDto => ({
  agent: { id: 'a1', name: 'Fern' },
  limits: { tokens: 2_000_000, runs: 40 },
  period: { key: '2026-11', starts_at: '2026-11-01T00:00:00.000Z', resets_at: '2026-12-01T00:00:00.000Z' },
  tokens: { limit: 2_000_000, used: 610_400, percent: 30, state: 'ok', measurement: 'full', unmeasured_runs: 0 },
  runs: { limit: 40, used: 21, percent: 52, state: 'ok' },
  state: 'ok',
  paused_reason: null,
  resumes_at: null,
  ...over,
});
const warning = base({ state: 'warning', runs: { limit: 40, used: 33, percent: 82, state: 'warning' } });
const paused = base({ state: 'paused', paused_reason: 'runs', resumes_at: '2026-12-01T00:00:00.000Z', runs: { limit: 40, used: 40, percent: 100, state: 'paused' } });
const none = base({ state: 'none', limits: { tokens: null, runs: null }, runs: { limit: null, used: 21, percent: null, state: 'unlimited' }, tokens: { limit: null, used: 610_400, percent: null, state: 'unlimited', measurement: 'full', unmeasured_runs: 0 } });

const card = (budget: BudgetDto | null, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(BudgetCard, { status: 'ready', budget, agentName: 'Fern', canEdit: true, ownerName: null, saving: false, onSave: async () => {}, onRetry: () => {}, ...over }),
  );

describe('#1268 the card, per state', () => {
  it('ok: both figures with bars in primary, the reset date, no chip, "Change budget" for a manager', () => {
    const html = card(base());
    expect(html).toContain('Budget this month');
    expect(html).toContain('Resets 1 Dec');
    expect(html).toContain('21 of 40');
    expect(html).toContain('610,400 of 2,000,000');
    expect(html).toContain('bg-primary');
    expect(html).not.toContain('data-testid="budget-chip"');
    expect(html).toContain('Change budget');
    expect(html).not.toContain('Raise budget');
  });

  it('warning: amber bar, the "Over 80%" chip, and the line saying what happens at the limit', () => {
    const html = card(warning);
    expect(html).toContain('Over 80%');
    expect(html).toContain('bg-warning');
    expect(html).toContain('At 40 Fern pauses until you raise the budget or 1 Dec.');
    expect(html).toContain('Change budget');
  });

  it('paused: the grey "Paused" chip, the run row\'s own words, and "Raise budget" as the primary action', () => {
    const html = card(paused);
    expect(html).toContain('>Paused<');
    expect(html).toContain('Monthly run budget reached, resumes');
    expect(html).toContain("Work waits in Fern&#x27;s queue until then.");
    expect(html).toContain('Raise budget');
    expect(html).not.toContain('Change budget');
    expect(html).not.toContain('bg-warning');
  });

  it('no budget: says so, states the month so far, and offers "Set a budget"', () => {
    const html = card(none);
    expect(html).toContain('No budget.');
    expect(html).toContain('Fern runs whenever its triggers fire. This month: 21 runs, 610,400 tokens.');
    expect(html).toContain('Set a budget');
    expect(html).not.toContain('role="progressbar"');
  });

  it('no budget with unreported tokens says "tokens not reported", never "0 tokens"', () => {
    const html = card({ ...none, tokens: { ...none.tokens, used: null, state: 'not_measured', measurement: 'not_reported' } });
    expect(html).toContain('tokens not reported');
    expect(html).not.toMatch(/\b0 tokens/);
  });

  it('a real zero in a budgeted month is drawn as 0', () => {
    const html = card(base({ runs: { limit: 40, used: 0, percent: 0, state: 'ok' }, tokens: { ...base().tokens, used: 0, percent: 0 } }));
    expect(html).toContain('0 of 40');
    expect(html).toContain('0 of 2,000,000');
  });

  it('tokens not reported: "Not reported · limit …", no token bar, and the reason in one line', () => {
    const html = card(base({ tokens: { ...base().tokens, used: null, percent: null, state: 'not_measured', measurement: 'not_reported' } }));
    expect(html).toContain('Not reported · limit 2,000,000');
    expect(html).toContain("Its tool doesn&#x27;t say how many tokens it used");
    expect(html.match(/role="progressbar"/g)?.length).toBe(1); // the runs bar only
  });

  it('partial tokens: "at least N" and how many runs the total leaves out', () => {
    const html = card(base({ tokens: { ...base().tokens, measurement: 'partial', unmeasured_runs: 3 } }));
    expect(html).toContain('at least 610,400 of 2,000,000');
    expect(html).toContain("3 finished runs didn&#x27;t report tokens");
  });

  it('never uses gold: a budget is a rule a person set, not an agent acting', () => {
    for (const b of [base(), warning, paused, none]) expect(card(b)).not.toMatch(/accent|gold/);
  });
});

describe('#1268 who sees the controls', () => {
  it('a reader (no write access) sees the numbers read-only with the one line saying who manages the agent, and no button', () => {
    for (const b of [base(), warning, paused, none]) {
      const html = card(b, { canEdit: false, ownerName: 'Maya Chen' });
      expect(html).toContain(readOnlyLine('Maya Chen').replace(/'/g, '&#x27;'));
      expect(html).not.toMatch(/Change budget|Raise budget|Set a budget/);
    }
    expect(card(base(), { canEdit: false, ownerName: 'Maya Chen' })).toContain('21 of 40');
  });

  it('a reader whose manager is not known is told "its owner", never a blank', () => {
    expect(card(base(), { canEdit: false, ownerName: null })).toContain('Only its owner, who manages this agent, can change these.');
  });

  it('a manager sees no read-only line', () => {
    expect(card(base(), { canEdit: true })).not.toContain('can change these');
  });
});

describe('#1268 loading and failing', () => {
  it('loading says so; a failed read says so with a way to retry; neither shows a figure', () => {
    const loading = card(null, { status: 'loading' });
    expect(loading).toContain('Loading…');
    expect(loading).not.toMatch(/ of /);
    const failed = card(null, { status: 'error' });
    expect(failed).toContain('Couldn’t load Fern’s budget.');
    expect(failed).toContain('Try again');
    expect(failed).not.toMatch(/Change budget|Set a budget/);
  });

  it('the card can be linked to: id="budget"', () => {
    expect(card(base())).toContain('id="budget"');
  });
});

describe('#1268 a run waiting on the budget links to the card', () => {
  const wake = (state: RunStateName): WakeDto => ({
    id: `w-${state}`,
    agent: { id: 'a1', name: 'Fern' },
    record: { id: 'rec', database_id: 'db', title: 'A record', number: 1 },
    reason: 'state_change',
    coalesced_count: 1,
    status: 'queued',
    run_id: null,
    run_state: { state, until: '2026-12-01T00:00:00.000Z', budget_metric: 'runs' },
    created_at: '2026-11-12T09:00:00Z',
    finished_at: null,
  });
  const list = (state: RunStateName, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RunList, { ws: 'w1', wakes: [wake(state)], more: false, ...extra }));

  it('only a budget-waiting row, and only when the card exists on the page', () => {
    expect(list('waiting_for_budget', { budgetHref: '#budget' })).toContain('href="#budget"');
    expect(list('waiting_for_budget')).not.toContain('See budget');
    for (const s of ['running', 'done', 'failed', 'waiting_for_limit', 'waiting_for_runner'] as RunStateName[]) {
      expect(list(s, { budgetHref: '#budget' }), s).not.toContain('See budget');
    }
  });
});

describe('#1268 the page draws the card only when the API answered', () => {
  const page = readFileSync(fileURLToPath(new URL('./agent-page.tsx', import.meta.url)), 'utf8');
  const queries = readFileSync(fileURLToPath(new URL('../../lib/runners/queries.ts', import.meta.url)), 'utf8');
  it('a 404 is read as "no card" (null), and the page mounts the card only for loading, failed or answered', () => {
    expect(queries).toContain('status === 404) return null');
    expect(page).toContain('(budget.isPending || budget.isError || budget.data) && (');
  });
  it('controls follow the Agents database write bar, the same gate Advanced uses', () => {
    expect(page).toMatch(/<BudgetCard[\s\S]*?canEdit=\{canEditAgentSettings\(myAccess\)\}/);
  });
});
