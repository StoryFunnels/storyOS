import { describeRun } from './status';
import { shortDate } from './words';
import type { TimeOpts } from './words';
import type { WakeDto } from './types';

/**
 * Ticket #1268 (the web half of #1138) — an agent's monthly budget, read and written.
 *
 * Every number on the card is the API's (`GET /agents/{agent}/budget`, apps/api/src/runners/agent-budget.ts): used, limit, percent,
 * and the state (warning from 80%, paused at 100%). Nothing here estimates a total or fills a gap. Two rules carry the weight:
 *  - a ZERO is a quantity and "not measured" is not zero: `tokens.used` is null when no finished run reported usage, and is shown as
 *    "Not reported", never as 0 (CLAUDE.md: never guess numbers; a confident zero invites no checking);
 *  - the pause is DERIVED, not stored: raising a limit above what is used resumes the agent, so the page says "Saving resumes it now"
 *    only when that is what the save will do (`stillPausedAfter`).
 */
export type BudgetMetricState = 'unlimited' | 'ok' | 'warning' | 'paused' | 'not_measured';
export type TokenMeasurement = 'full' | 'partial' | 'not_reported' | 'no_finished_runs';

export interface BudgetMetricDto {
  limit: number | null;
  used: number | null;
  percent: number | null;
  state: BudgetMetricState;
}

export interface BudgetTokensDto extends BudgetMetricDto {
  measurement: TokenMeasurement;
  unmeasured_runs: number;
}

export interface BudgetDto {
  agent: { id: string; name: string };
  limits: { tokens: number | null; runs: number | null };
  period: { key: string; starts_at: string; resets_at: string };
  tokens: BudgetTokensDto;
  runs: BudgetMetricDto;
  state: 'none' | 'ok' | 'warning' | 'paused';
  paused_reason: 'tokens' | 'runs' | null;
  resumes_at: string | null;
}

/** The API's own refusals for a limit (`budgetWriteProblem`), word for word, so a typo is caught before the round trip. A drift test reads the API source. */
export const BUDGET_PROBLEM_NOT_WHOLE = 'A budget must be a whole number (or empty for no limit).';
export const BUDGET_PROBLEM_TOO_SMALL = 'A budget must be at least 1. To stop an agent, switch it off; to remove the budget, clear the field.';
export const BUDGET_PROBLEM_TOO_LARGE = 'That budget is too large to be real. Clear the field for no limit.';
export const BUDGET_MAX = 1e12;

export interface BudgetDraft {
  /** What to send: null clears the limit (empty box), a whole number sets it. */
  value: number | null;
  error: string | null;
}

export function budgetDraft(raw: string): BudgetDraft {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return { value: null, error: null };
  const n = Number(text);
  if (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(n) || !Number.isInteger(n)) return { value: null, error: BUDGET_PROBLEM_NOT_WHOLE };
  if (n < 1) return { value: null, error: BUDGET_PROBLEM_TOO_SMALL };
  if (n > BUDGET_MAX) return { value: null, error: BUDGET_PROBLEM_TOO_LARGE };
  return { value: n, error: null };
}

export const countText = (n: number): string => n.toLocaleString('en-US');

/**
 * "Resets 1 Dec", in the same short form as the runs on this page. The instant is the UTC month rolling over; it is READ in the viewer's own
 * zone (`o` is for tests), like the paused sentence beside it, so one card never shows two different days for the same moment.
 */
export function resetsLabel(resetsAtIso: string, o: TimeOpts = {}): string {
  return `Resets ${shortDate(resetsAtIso, o)}`;
}

export interface MetricView {
  /** "21 of 40", "at least 610,400 of 2,000,000", "Not reported · limit 2,000,000", "21 (no limit)". */
  text: string;
  /** 0..100 for the bar, or null when there is nothing to draw one from (no limit, or no measurement). */
  barPercent: number | null;
  state: BudgetMetricState;
}

const wholePercent = (used: number, limit: number): number => Math.min(100, Math.floor((used * 100) / limit));

export function runsView(m: BudgetMetricDto): MetricView {
  const used = m.used ?? 0;
  if (m.limit === null) return { text: `${countText(used)} (no limit)`, barPercent: null, state: m.state };
  return { text: `${countText(used)} of ${countText(m.limit)}`, barPercent: m.percent !== null ? Math.min(100, m.percent) : wholePercent(used, m.limit), state: m.state };
}

export function tokensView(m: BudgetTokensDto): MetricView {
  if (m.used === null) {
    return { text: m.limit === null ? 'Not reported' : `Not reported · limit ${countText(m.limit)}`, barPercent: null, state: m.state };
  }
  const lead = m.measurement === 'partial' ? 'at least ' : '';
  if (m.limit === null) return { text: `${lead}${countText(m.used)} (no limit)`, barPercent: null, state: m.state };
  return { text: `${lead}${countText(m.used)} of ${countText(m.limit)}`, barPercent: m.percent !== null ? Math.min(100, m.percent) : wholePercent(m.used, m.limit), state: m.state };
}

/** The one-line reason a token figure is missing or partial; null when every finished run reported (or there is nothing to explain). */
export function tokensNote(m: BudgetTokensDto): string | null {
  if (m.used === null) {
    return m.measurement === 'no_finished_runs'
      ? 'No run has finished this month, so there is nothing to count yet.'
      : "Its tool doesn't say how many tokens it used, so only runs are counted against the budget.";
  }
  if (m.measurement === 'partial' && m.unmeasured_runs > 0) {
    return `${m.unmeasured_runs} finished ${m.unmeasured_runs === 1 ? "run didn't" : "runs didn't"} report tokens, so the real total is higher.`;
  }
  return null;
}

/** "At 40 Fern pauses until you raise the budget or 1 Dec." for a metric in its warning band. */
export function warningLine(agentName: string, limit: number, resetsAtIso: string, o: TimeOpts = {}): string {
  return `At ${countText(limit)} ${agentName} pauses until you raise the budget or ${shortDate(resetsAtIso, o)}.`;
}

/**
 * The paused sentence: the run row's own words (`describeRun` on a `waiting_for_budget` state, ticket #1248), never a copy of them,
 * plus what that means for the work. Reusing the function is what keeps the card and the Runs list saying one thing.
 */
export function pausedLine(agentName: string, b: Pick<BudgetDto, 'paused_reason' | 'resumes_at'>, o: TimeOpts = {}): string {
  const w = { run_state: { state: 'waiting_for_budget', until: b.resumes_at ?? undefined, budget_metric: b.paused_reason ?? undefined } } as unknown as WakeDto;
  return `${describeRun(w, o).label}. Work waits in ${agentName}'s queue until then.`;
}

/**
 * Whether the agent would STILL be paused with these limits: a metric is paused while its used count has reached its limit, and a
 * limit that is cleared (null) never pauses. A token total that was not reported cannot pause (nothing is known to have been used).
 */
export function stillPausedAfter(b: Pick<BudgetDto, 'runs' | 'tokens'>, next: { runs: number | null; tokens: number | null }): boolean {
  const runsPaused = next.runs !== null && (b.runs.used ?? 0) >= next.runs;
  const tokensPaused = next.tokens !== null && b.tokens.used !== null && b.tokens.used >= next.tokens;
  return runsPaused || tokensPaused;
}

/** "Saving resumes Fern now": only when the agent is paused and these limits lift every pause. */
export function resumesNowNote(agentName: string, b: BudgetDto, next: { runs: number | null; tokens: number | null }): string | null {
  return b.state === 'paused' && !stillPausedAfter(b, next) ? `Saving resumes ${agentName} now.` : null;
}
