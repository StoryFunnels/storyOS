/**
 * MN-253 — the automation-job retry schedule: 30s, 2m, 10m, 1h, then give up.
 *
 * webhook-sender.ts's `nextAttemptDelayMs` (MN-032/088) already owns a backoff
 * schedule for outgoing webhook deliveries, but it's a *different* one
 * (exponential 1/2/4/8 min) — the ticket's guide asked to "generalize" that
 * function, but the two schedules don't share a formula (this one isn't a
 * power of two), so reusing it would either change webhook delivery's existing
 * behavior or require threading a schedule array through its call sites for no
 * reason. This is a deliberate sibling, not the same function: same shape
 * (attempts-so-far → delay | null), same MAX_ATTEMPTS-based cutoff, separate
 * schedule.
 */
export const MAX_ATTEMPTS = 5;

const SCHEDULE_MS = [30_000, 120_000, 600_000, 3_600_000];

/**
 * `attempts` is the number of attempts already made (including the one that
 * just failed). Returns the delay before the next attempt, or null once
 * MAX_ATTEMPTS is reached — the signal to mark the job permanently failed.
 */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return SCHEDULE_MS[attempts - 1] ?? SCHEDULE_MS[SCHEDULE_MS.length - 1]!;
}
