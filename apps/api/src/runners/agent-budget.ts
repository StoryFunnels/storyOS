/**
 * ticket #1138 / ADR-0021 §1, §5: a budget per agent, in tokens and in runs, per UTC calendar month. Warn at 80%, pause at 100%.
 * Pure functions: nothing here reads the clock or the database (`now` is passed in), so every rule a number or a time obeys is
 * testable with a clock the test owns. The service that reads the Runs records and sends the notices is `agent-budget.service.ts`.
 *
 * The pause is DERIVED, never stored: an agent is paused exactly while usage >= limit for the month in question. Raising the budget
 * therefore resumes it and a new month resumes it, with no flag to clear and nothing that can be left stuck.
 */

/** The two number fields on the Agents database a manager sets. A field is a row (no migration), like Tools and Model. */
export const BUDGET_TOKEN_FIELD = 'monthly_token_budget';
export const BUDGET_RUN_FIELD = 'monthly_run_cap';
export const BUDGET_FIELD_NAMES = [BUDGET_TOKEN_FIELD, BUDGET_RUN_FIELD] as const;

export const BUDGET_WARN_PERCENT = 80;
/** A budget this large is a typo (it is also past the range a JSON number keeps exact), so it is refused rather than stored. */
export const BUDGET_MAX = 1e12;

export interface BudgetPeriod {
  /** "2026-11". Part of the key that makes a notice fire once per month. */
  key: string;
  startsAt: Date;
  /** When usage starts again from nothing, and a paused agent resumes. */
  resetsAt: Date;
}

/** The UTC calendar month `now` falls in. UTC, not the viewer's zone: one month for the whole workspace, whoever looks. */
export function budgetPeriod(now: Date): BudgetPeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    startsAt: new Date(Date.UTC(y, m, 1)),
    resetsAt: new Date(Date.UTC(y, m + 1, 1)),
  };
}

/** A stored limit as the rules read it: a positive whole number, else "no limit". A zero is never a limit (it would divide by zero and freeze an agent silently). */
export function parseBudgetLimit(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > BUDGET_MAX) return null;
  return raw;
}

/** The write-time rule: clearing is fine; anything else must be a whole number from 1. Returns the sentence to show, or null. */
export function budgetWriteProblem(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) return 'A budget must be a whole number (or empty for no limit).';
  if (raw < 1) return 'A budget must be at least 1. To stop an agent, switch it off; to remove the budget, clear the field.';
  if (raw > BUDGET_MAX) return 'That budget is too large to be real. Clear the field for no limit.';
  return null;
}

export interface BudgetLimits {
  tokens: number | null;
  runs: number | null;
}

/** What the Runs records of one agent say for one month. Counts and one sum, all from SQL (counting is not fetching). */
export interface BudgetUsage {
  /** Runs a Runner actually STARTED (a Run still queued has used nothing). */
  runs: number;
  /** The sum of tokens in + out over the runs that REPORTED them. Not a total of all runs when some did not report. */
  tokens: number;
  runsWithTokens: number;
  /** Runs that have ended at least one attempt (their `Exit` is set). */
  finishedRuns: number;
  /** Of those, how many ended without the tool reporting usage. These are the runs the token total does not cover. */
  finishedWithoutTokens: number;
  /**
   * AI-field calls this agent caused (Otto, 2026-11-03, from ticket #1179), from the `outward.ai_field` log rows that carry the agent.
   * `aiFieldTokens` is the sum over the calls whose vendor REPORTED usage, `aiFieldCallsWithTokens` how many that is, and
   * `aiFieldCallsWithoutTokens` how many finished without the vendor saying (an explicit null on the row). A call that failed has neither.
   */
  aiFieldTokens: number;
  aiFieldCallsWithTokens: number;
  aiFieldCallsWithoutTokens: number;
}

export type MetricState = 'unlimited' | 'ok' | 'warning' | 'paused' | 'not_measured';
export type TokenMeasurement = 'full' | 'partial' | 'not_reported' | 'no_finished_runs';

export interface RunsMetric {
  limit: number | null;
  used: number;
  percent: number | null;
  state: MetricState;
}

export interface TokensMetric {
  limit: number | null;
  /** null = no finished run reported (the tool does not say). NEVER 0 for that case (CLAUDE.md: a zero is a quantity). */
  used: number | null;
  percent: number | null;
  state: MetricState;
  measurement: TokenMeasurement;
  /** Finished runs the total does not cover. The page must show this next to the number, not hide it. */
  unmeasured_runs: number;
  /** The part of `used` that AI fields caused, and how many calls: `tokens` is null when calls finished and none reported usage, 0 when there were no calls. */
  ai_field: { tokens: number | null; calls: number; unmeasured_calls: number };
}

export interface BudgetStatus {
  period: { key: string; starts_at: string; resets_at: string };
  tokens: TokensMetric;
  runs: RunsMetric;
  /** The worst of the two: paused > warning > ok; `none` when neither limit is set. */
  state: 'none' | 'ok' | 'warning' | 'paused';
  paused_reason: 'tokens' | 'runs' | null;
  /** When a paused agent resumes by itself (the month rolling over). Raising the budget resumes it sooner. */
  resumes_at: Date | null;
}

/** Integer arithmetic only: 80% of 3 is 2.4, and a float comparison must never decide a pause. */
function metricState(limit: number | null, used: number): MetricState {
  if (limit === null) return 'unlimited';
  if (used >= limit) return 'paused';
  if (used * 100 >= limit * BUDGET_WARN_PERCENT) return 'warning';
  return 'ok';
}

const percentOf = (limit: number | null, used: number): number | null => (limit === null ? null : Math.floor((used * 100) / limit));

export function evaluateBudget(limits: BudgetLimits, u: BudgetUsage, period: BudgetPeriod): BudgetStatus {
  let measurement: TokenMeasurement;
  let tokensUsed: number | null;
  // Runs and AI-field calls are two sources of one token total. A source that did not report is never a zero inside it.
  const reporters = u.runsWithTokens + u.aiFieldCallsWithTokens;
  const finished = u.finishedRuns + u.aiFieldCallsWithTokens + u.aiFieldCallsWithoutTokens;
  const unmeasured = u.finishedWithoutTokens + u.aiFieldCallsWithoutTokens;
  if (finished === 0 && reporters === 0) {
    measurement = 'no_finished_runs';
    tokensUsed = 0;
  } else if (reporters === 0) {
    measurement = 'not_reported';
    tokensUsed = null;
  } else {
    measurement = unmeasured > 0 ? 'partial' : 'full';
    tokensUsed = u.tokens + u.aiFieldTokens;
  }
  const tokens: TokensMetric = {
    limit: limits.tokens,
    used: tokensUsed,
    percent: tokensUsed === null ? null : percentOf(limits.tokens, tokensUsed),
    state: tokensUsed === null ? (limits.tokens === null ? 'unlimited' : 'not_measured') : metricState(limits.tokens, tokensUsed),
    measurement,
    unmeasured_runs: u.finishedWithoutTokens,
    ai_field: {
      tokens: u.aiFieldCallsWithTokens === 0 && u.aiFieldCallsWithoutTokens > 0 ? null : u.aiFieldTokens,
      calls: u.aiFieldCallsWithTokens + u.aiFieldCallsWithoutTokens,
      unmeasured_calls: u.aiFieldCallsWithoutTokens,
    },
  };
  const runs: RunsMetric = { limit: limits.runs, used: u.runs, percent: percentOf(limits.runs, u.runs), state: metricState(limits.runs, u.runs) };

  const pausedBy: 'tokens' | 'runs' | null = tokens.state === 'paused' ? 'tokens' : runs.state === 'paused' ? 'runs' : null;
  const anySet = limits.tokens !== null || limits.runs !== null;
  const state: BudgetStatus['state'] = !anySet ? 'none' : pausedBy ? 'paused' : tokens.state === 'warning' || runs.state === 'warning' ? 'warning' : 'ok';
  return {
    period: { key: period.key, starts_at: period.startsAt.toISOString(), resets_at: period.resetsAt.toISOString() },
    tokens,
    runs,
    state,
    paused_reason: pausedBy,
    resumes_at: pausedBy ? period.resetsAt : null,
  };
}

export interface BudgetNotice {
  metric: 'tokens' | 'runs';
  level: 'warning' | 'paused';
  limit: number;
  /** Recorded so it can never be sent later, but not sent now (the usage jumped past it straight to the next level). */
  silent?: true;
}

/**
 * The notices a status calls for, each of which is sent at most once per (agent, month, metric, level, limit value) by the service.
 * Reaching 100% records the 80% notice too, silently: someone who is told "paused" does not need "80%" a minute later, and a
 * run-cap that moves 4 -> 5 of 5 must not send the warning on its own after the pause message.
 */
export function noticeFor(s: BudgetStatus): BudgetNotice[] {
  const out: BudgetNotice[] = [];
  for (const metric of ['tokens', 'runs'] as const) {
    const m = s[metric];
    if (m.limit === null) continue;
    if (m.state === 'warning') out.push({ metric, level: 'warning', limit: m.limit });
    else if (m.state === 'paused') {
      out.push({ metric, level: 'warning', limit: m.limit, silent: true });
      out.push({ metric, level: 'paused', limit: m.limit });
    }
  }
  return out;
}
