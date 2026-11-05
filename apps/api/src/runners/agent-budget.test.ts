import { describe, expect, it } from 'vitest';
import { budgetPeriod, budgetWriteProblem, evaluateBudget, noticeFor, parseBudgetLimit } from './agent-budget';
import type { BudgetUsage } from './agent-budget';

/** ticket #1138: the pure rules, with a clock the test owns. Every instant is an explicit UTC time. */
const at = (iso: string) => new Date(iso);
const period = budgetPeriod(at('2026-11-15T12:00:00Z'));
const usage = (u: Partial<BudgetUsage> = {}): BudgetUsage => ({
  runs: 0,
  tokens: 0,
  runsWithTokens: 0,
  finishedRuns: 0,
  finishedWithoutTokens: 0,
  aiFieldTokens: 0,
  aiFieldCallsWithTokens: 0,
  aiFieldCallsWithoutTokens: 0,
  ...u,
});

describe('the month', () => {
  it('is the UTC calendar month: starts at 00:00Z on the 1st and resets at 00:00Z on the 1st of the next', () => {
    expect(period.key).toBe('2026-11');
    expect(period.startsAt).toEqual(at('2026-11-01T00:00:00Z'));
    expect(period.resetsAt).toEqual(at('2026-12-01T00:00:00Z'));
  });
  it('rolls over a year and keeps the last second of a month inside it', () => {
    expect(budgetPeriod(at('2026-12-31T23:59:59Z')).resetsAt).toEqual(at('2027-01-01T00:00:00Z'));
    expect(budgetPeriod(at('2026-12-31T23:59:59Z')).key).toBe('2026-12');
    expect(budgetPeriod(at('2027-01-01T00:00:00Z')).key).toBe('2027-01');
  });
});

describe('a limit is a positive whole number, and anything else is "no limit", never zero', () => {
  it('parses numbers and refuses zero, negatives, fractions, text and non-finite values', () => {
    expect(parseBudgetLimit(500000)).toBe(500000);
    for (const bad of [0, -1, 1.5, '100', null, undefined, NaN, Infinity, {}, true]) expect(parseBudgetLimit(bad)).toBeNull();
  });
  it('the write guard lets a manager clear a budget and refuses a value that cannot be a budget, saying why', () => {
    expect(budgetWriteProblem(null)).toBeNull();
    expect(budgetWriteProblem(250000)).toBeNull();
    expect(budgetWriteProblem(0)).toMatch(/at least 1/);
    expect(budgetWriteProblem(-5)).toMatch(/at least 1/);
    expect(budgetWriteProblem(2.5)).toMatch(/whole number/);
    expect(budgetWriteProblem('lots')).toMatch(/whole number/);
    expect(budgetWriteProblem(1e15)).toMatch(/too large/);
  });
});

describe('the threshold: warn at 80%, pause at 100%, decided on whole numbers', () => {
  const tokens = (used: number, limit = 1000) => evaluateBudget({ tokens: limit, runs: null }, usage({ tokens: used, runsWithTokens: 1, finishedRuns: 1 }), period).tokens;
  it('799 of 1000 is ok, 800 warns, 999 warns, 1000 pauses, and so does going past it', () => {
    expect(tokens(799).state).toBe('ok');
    expect(tokens(800).state).toBe('warning');
    expect(tokens(999).state).toBe('warning');
    expect(tokens(1000).state).toBe('paused');
    expect(tokens(4000).state).toBe('paused');
  });
  it('is exact where a float is not: 80% of 3 is 2.4, so 2 is ok and 3 is the 100% pause (never a warning in between)', () => {
    expect(tokens(2, 3).state).toBe('ok');
    expect(tokens(3, 3).state).toBe('paused');
    expect(tokens(4, 5).state).toBe('warning');
  });
  it('reports the percent as a whole number, rounded down, so 99.9% never reads as 100', () => {
    expect(tokens(999).percent).toBe(99);
    expect(tokens(1000).percent).toBe(100);
  });
  it('with no limit set the metric is unlimited and nothing pauses, however much was used', () => {
    const s = evaluateBudget({ tokens: null, runs: null }, usage({ tokens: 9e9, runs: 5000, runsWithTokens: 1, finishedRuns: 1 }), period);
    expect(s.tokens.state).toBe('unlimited');
    expect(s.runs.state).toBe('unlimited');
    expect(s.state).toBe('none');
    expect(s.paused_reason).toBeNull();
  });
  it('either limit pauses the agent, and the status names which one and when the month resets', () => {
    const byRuns = evaluateBudget({ tokens: 1_000_000, runs: 10 }, usage({ runs: 10, tokens: 10, runsWithTokens: 10, finishedRuns: 10 }), period);
    expect(byRuns.state).toBe('paused');
    expect(byRuns.paused_reason).toBe('runs');
    expect(byRuns.resumes_at).toEqual(period.resetsAt);
    const byTokens = evaluateBudget({ tokens: 100, runs: 10 }, usage({ runs: 2, tokens: 100, runsWithTokens: 2, finishedRuns: 2 }), period);
    expect(byTokens.paused_reason).toBe('tokens');
    const none = evaluateBudget({ tokens: 100, runs: 10 }, usage({ runs: 2, tokens: 10, runsWithTokens: 2, finishedRuns: 2 }), period);
    expect(none.state).toBe('ok');
    expect(none.resumes_at).toBeNull();
  });
});

describe('tokens the tool did not report are never counted as zero (CLAUDE.md: never guess numbers)', () => {
  it('finished runs and not one reported: used is null, the state is not_measured and it can NOT pause on tokens, and the runs say how many', () => {
    const t = evaluateBudget({ tokens: 1000, runs: null }, usage({ runs: 7, tokens: 0, finishedRuns: 7, finishedWithoutTokens: 7 }), period).tokens;
    expect(t.used).toBeNull();
    expect(t.percent).toBeNull();
    expect(t.state).toBe('not_measured');
    expect(t.measurement).toBe('not_reported');
    expect(t.unmeasured_runs).toBe(7);
  });
  it('the run cap still holds when tokens cannot be measured', () => {
    const s = evaluateBudget({ tokens: 1000, runs: 7 }, usage({ runs: 7, finishedRuns: 7, finishedWithoutTokens: 7 }), period);
    expect(s.tokens.state).toBe('not_measured');
    expect(s.runs.state).toBe('paused');
    expect(s.state).toBe('paused');
    expect(s.paused_reason).toBe('runs');
  });
  it('mixed: the total covers the runs that reported (a lower bound), is labelled partial and names how many are missing', () => {
    const t = evaluateBudget({ tokens: 1000, runs: null }, usage({ runs: 4, tokens: 900, runsWithTokens: 3, finishedRuns: 4, finishedWithoutTokens: 1 }), period).tokens;
    expect(t.used).toBe(900);
    expect(t.measurement).toBe('partial');
    expect(t.unmeasured_runs).toBe(1);
    expect(t.state).toBe('warning');
  });
  it('nothing finished yet: used is a true 0 labelled no_finished_runs, not a claim that the tool reports nothing', () => {
    const t = evaluateBudget({ tokens: 1000, runs: null }, usage({ runs: 1 }), period).tokens;
    expect(t.used).toBe(0);
    expect(t.measurement).toBe('no_finished_runs');
    expect(t.state).toBe('ok');
  });
  it('tokens are shown even when no limit is set, so the page has the usage before a budget exists', () => {
    const t = evaluateBudget({ tokens: null, runs: null }, usage({ runs: 2, tokens: 321, runsWithTokens: 2, finishedRuns: 2 }), period);
    expect(t.tokens.used).toBe(321);
    expect(t.runs.used).toBe(2);
  });
});

describe('AI-field usage is a second source of the same token total (Otto, 2026-11-03)', () => {
  const eval1 = (u: Partial<BudgetUsage>, limit = 1000) => evaluateBudget({ tokens: limit, runs: null }, usage(u), period).tokens;
  it('is added to the runs\' tokens, and shown on its own', () => {
    const t = eval1({ tokens: 300, runsWithTokens: 1, finishedRuns: 1, aiFieldTokens: 500, aiFieldCallsWithTokens: 2 });
    expect(t.used).toBe(800);
    expect(t.state).toBe('warning');
    expect(t.measurement).toBe('full');
    expect(t.ai_field).toEqual({ tokens: 500, calls: 2, unmeasured_calls: 0 });
  });
  it('alone, with no run having finished, it is the whole total', () => {
    const t = eval1({ aiFieldTokens: 1000, aiFieldCallsWithTokens: 1 });
    expect(t.used).toBe(1000);
    expect(t.state).toBe('paused');
  });
  it('calls that finished without usage are null, never 0: not_reported alone, partial beside a reporter, and they never pause', () => {
    const none = eval1({ aiFieldCallsWithoutTokens: 3 });
    expect(none.used).toBeNull();
    expect(none.measurement).toBe('not_reported');
    expect(none.state).toBe('not_measured');
    expect(none.ai_field).toEqual({ tokens: null, calls: 3, unmeasured_calls: 3 });
    const mixed = eval1({ aiFieldTokens: 850, aiFieldCallsWithTokens: 1, aiFieldCallsWithoutTokens: 1 });
    expect(mixed.used).toBe(850);
    expect(mixed.measurement).toBe('partial');
    expect(mixed.state).toBe('warning');
  });
  it('no calls at all: the AI-field part is a true 0 over 0 calls', () => {
    expect(eval1({}).ai_field).toEqual({ tokens: 0, calls: 0, unmeasured_calls: 0 });
  });
});

describe('what to tell the manager, once', () => {
  const st = (tokens: number, limit = 1000) => evaluateBudget({ tokens: limit, runs: null }, usage({ tokens, runsWithTokens: 1, finishedRuns: 1 }), period);
  it('a metric that is ok says nothing; warning says the 80% notice; paused says the 100% notice', () => {
    expect(noticeFor(st(100))).toEqual([]);
    expect(noticeFor(st(850))).toEqual([{ metric: 'tokens', level: 'warning', limit: 1000 }]);
    expect(noticeFor(st(1000))).toEqual([
      { metric: 'tokens', level: 'warning', limit: 1000, silent: true },
      { metric: 'tokens', level: 'paused', limit: 1000 },
    ]);
  });
  it('a jump straight past 100% still records the 80% notice so it cannot arrive later, but only the pause one is sent', () => {
    const levels = noticeFor(st(5000));
    expect(levels.filter((n) => !n.silent).map((n) => n.level)).toEqual(['paused']);
  });
  it('not_measured and unlimited say nothing', () => {
    expect(noticeFor(evaluateBudget({ tokens: 1000, runs: null }, usage({ finishedRuns: 3, finishedWithoutTokens: 3 }), period))).toEqual([]);
    expect(noticeFor(evaluateBudget({ tokens: null, runs: null }, usage({ tokens: 99, runsWithTokens: 1, finishedRuns: 1 }), period))).toEqual([]);
  });
});
