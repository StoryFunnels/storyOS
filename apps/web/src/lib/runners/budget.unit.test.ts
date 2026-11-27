import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_PROBLEM_NOT_WHOLE,
  BUDGET_PROBLEM_TOO_LARGE,
  BUDGET_PROBLEM_TOO_SMALL,
  budgetDraft,
  pausedLine,
  resetsLabel,
  resumesNowNote,
  runsView,
  stillPausedAfter,
  tokensNote,
  tokensView,
  warningLine,
} from './budget';
import type { BudgetDto } from './budget';
import { describeRun } from './status';
import type { WakeDto } from './types';

/** Ticket #1268 — the budget card's rules. Every number is the API's; these pin how it is read, and above all that zero and "not measured" stay different. */
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

describe('#1268 budgetDraft: what a box becomes', () => {
  it('an empty box clears the limit; a whole number sets it (commas and spaces are not typos)', () => {
    expect(budgetDraft('')).toEqual({ value: null, error: null });
    expect(budgetDraft('   ')).toEqual({ value: null, error: null });
    expect(budgetDraft('40')).toEqual({ value: 40, error: null });
    expect(budgetDraft(' 2,000,000 ')).toEqual({ value: 2_000_000, error: null });
    expect(budgetDraft('1')).toEqual({ value: 1, error: null });
    expect(budgetDraft('1000000000000')).toEqual({ value: 1e12, error: null });
  });

  it("refuses with the API's own sentences: not whole, under 1, past the ceiling", () => {
    expect(budgetDraft('abc').error).toBe(BUDGET_PROBLEM_NOT_WHOLE);
    expect(budgetDraft('12.5').error).toBe(BUDGET_PROBLEM_NOT_WHOLE);
    expect(budgetDraft('1e3').error).toBe(BUDGET_PROBLEM_NOT_WHOLE);
    expect(budgetDraft('0').error).toBe(BUDGET_PROBLEM_TOO_SMALL);
    expect(budgetDraft('-5').error).toBe(BUDGET_PROBLEM_TOO_SMALL);
    expect(budgetDraft('1000000000001').error).toBe(BUDGET_PROBLEM_TOO_LARGE);
    for (const bad of ['abc', '0', '-5']) expect(budgetDraft(bad).value).toBeNull();
  });

  // The three sentences are the API's (`budgetWriteProblem`); a web copy that drifts would say one thing and the 422 another.
  it('the three sentences are the API\'s, word for word (read from its source)', () => {
    const api = readFileSync(fileURLToPath(new URL('../../../../api/src/runners/agent-budget.ts', import.meta.url)), 'utf8');
    for (const sentence of [BUDGET_PROBLEM_NOT_WHOLE, BUDGET_PROBLEM_TOO_SMALL, BUDGET_PROBLEM_TOO_LARGE]) expect(api, sentence).toContain(sentence);
  });
});

describe('#1268 the figures: zero is zero, not measured is not measured', () => {
  it('runs read "used of limit", and "(no limit)" without a bar when there is none', () => {
    expect(runsView(base().runs)).toEqual({ text: '21 of 40', barPercent: 52, state: 'ok' });
    expect(runsView({ limit: null, used: 7, percent: null, state: 'unlimited' })).toEqual({ text: '7 (no limit)', barPercent: null, state: 'unlimited' });
  });

  it('a real zero is drawn as 0, with an empty bar, never as "not reported"', () => {
    expect(runsView({ limit: 40, used: 0, percent: 0, state: 'ok' })).toEqual({ text: '0 of 40', barPercent: 0, state: 'ok' });
    expect(tokensView({ ...base().tokens, used: 0, percent: 0 }).text).toBe('0 of 2,000,000');
    expect(tokensView({ ...base().tokens, used: 0, percent: 0 }).barPercent).toBe(0);
  });

  it('unreported tokens (used null) are "Not reported", with no bar, with or without a limit', () => {
    const t = { ...base().tokens, used: null, percent: null, state: 'not_measured' as const, measurement: 'not_reported' as const };
    expect(tokensView(t)).toEqual({ text: 'Not reported · limit 2,000,000', barPercent: null, state: 'not_measured' });
    expect(tokensView({ ...t, limit: null }).text).toBe('Not reported');
    expect(tokensView(t).text).not.toMatch(/\b0\b/);
  });

  it('a partial total says "at least", and the note says how many runs it leaves out', () => {
    const t = { ...base().tokens, measurement: 'partial' as const, unmeasured_runs: 3 };
    expect(tokensView(t).text).toBe('at least 610,400 of 2,000,000');
    expect(tokensNote(t)).toBe("3 finished runs didn't report tokens, so the real total is higher.");
    expect(tokensNote({ ...t, unmeasured_runs: 1 })).toBe("1 finished run didn't report tokens, so the real total is higher.");
  });

  it('a full total has no note; an unreported one says why, and a month with no finished run says so', () => {
    expect(tokensNote(base().tokens)).toBeNull();
    expect(tokensNote({ ...base().tokens, used: null, measurement: 'not_reported' })).toMatch(/doesn't say how many tokens/);
    expect(tokensNote({ ...base().tokens, used: null, measurement: 'no_finished_runs' })).toMatch(/No run has finished this month/);
  });

  it('the bar never passes 100, even when the API reports more', () => {
    expect(runsView({ limit: 40, used: 55, percent: 137, state: 'paused' }).barPercent).toBe(100);
    expect(tokensView({ ...base().tokens, used: 3_000_000, percent: 150, state: 'paused' }).barPercent).toBe(100);
  });

  it('the bar falls back to a rounded-down whole percent when the API sent none', () => {
    expect(runsView({ limit: 3, used: 2, percent: null, state: 'ok' }).barPercent).toBe(66);
  });
});

describe('#1268 the words', () => {
  it('the reset date is read in UTC (the month is the UTC month), in the page\'s short form', () => {
    expect(resetsLabel('2026-12-01T00:00:00.000Z')).toBe('Resets 1 Dec');
  });

  it('a warning names the limit it is at and when it resets', () => {
    expect(warningLine('Fern', 40, '2026-12-01T00:00:00.000Z')).toBe('At 40 Fern pauses until you raise the budget or 1 Dec.');
    expect(warningLine('Fern', 2_000_000, '2026-12-01T00:00:00.000Z')).toBe('At 2,000,000 Fern pauses until you raise the budget or 1 Dec.');
  });

  it("the paused sentence IS the run row's own label (describeRun), plus what the pause means", () => {
    const b = base({ state: 'paused', paused_reason: 'runs', resumes_at: '2026-12-01T00:00:00.000Z' });
    const row = describeRun({ run_state: { state: 'waiting_for_budget', until: b.resumes_at!, budget_metric: 'runs' } } as unknown as WakeDto).label;
    expect(row).toMatch(/^Monthly run budget reached/);
    expect(pausedLine('Fern', b)).toBe(`${row}. Work waits in Fern's queue until then.`);
    expect(pausedLine('Fern', { ...b, paused_reason: 'tokens' })).toMatch(/^Monthly token budget reached/);
  });
});

describe('#1268 resuming: derived from the numbers, never promised', () => {
  const paused = base({ state: 'paused', paused_reason: 'runs', runs: { limit: 40, used: 40, percent: 100, state: 'paused' } });

  it('raising the run cap above what is used lifts the pause; keeping it at or under does not', () => {
    expect(stillPausedAfter(paused, { runs: 60, tokens: 2_000_000 })).toBe(false);
    expect(stillPausedAfter(paused, { runs: 40, tokens: 2_000_000 })).toBe(true);
    expect(stillPausedAfter(paused, { runs: 30, tokens: null })).toBe(true);
  });

  it('clearing a limit lifts that metric\'s pause', () => {
    expect(stillPausedAfter(paused, { runs: null, tokens: 2_000_000 })).toBe(false);
  });

  it('unreported tokens cannot hold a pause (nothing is known to be used)', () => {
    const b = base({ tokens: { ...base().tokens, used: null, measurement: 'not_reported', state: 'not_measured', percent: null } });
    expect(stillPausedAfter(b, { runs: null, tokens: 1 })).toBe(false);
  });

  it('a token pause is held by the token limit', () => {
    const b = base({ state: 'paused', paused_reason: 'tokens', tokens: { ...base().tokens, used: 2_000_000, percent: 100, state: 'paused' } });
    expect(stillPausedAfter(b, { runs: 40, tokens: 2_000_000 })).toBe(true);
    expect(stillPausedAfter(b, { runs: 40, tokens: 3_000_000 })).toBe(false);
  });

  it('"Saving resumes Fern now." only when it is paused and the new limits lift every pause', () => {
    expect(resumesNowNote('Fern', paused, { runs: 60, tokens: 2_000_000 })).toBe('Saving resumes Fern now.');
    expect(resumesNowNote('Fern', paused, { runs: 40, tokens: 2_000_000 })).toBeNull();
    expect(resumesNowNote('Fern', base(), { runs: 100, tokens: null })).toBeNull();
    expect(resumesNowNote('Fern', base({ state: 'warning' }), { runs: 100, tokens: null })).toBeNull();
  });
});
