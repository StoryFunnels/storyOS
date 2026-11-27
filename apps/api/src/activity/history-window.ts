import { PURGE_NOT_BEFORE } from './activity-retention.service';

/**
 * Ticket #1386 — the plan window (plans.ts `historyRetentionDays`) on the READ side of version history.
 *
 * Until now the window only gated CAPTURE, so a customer could list and restore history older than their plan allows. From
 * {@link PURGE_NOT_BEFORE} on, a version or field change older than the workspace's window is not listed and not restorable.
 *
 * WHY THE FILTER SHARES THE PURGE'S NOT-BEFORE DATE (Ievgen, ticket #1385: nothing is deleted before 2026-12-27 UTC). Hiding is not
 * deleting, but it is the part a person SEES: a Free workspace that today lists three months of history would lose it on the day
 * this ships, which is the same surprise the date exists to prevent. So before the date nothing changes for anyone, and the filter
 * and the purge start on the same instant. The constant is imported, never copied: one date, one place to remove it.
 */
export const windowClock = {
  /** TEST SEAM: the clock the window is judged by. Production never replaces it (a faked Date would also expire the test's own session). */
  now: (): Date => new Date(),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** True once the window applies on the read side. A cheap check, made BEFORE any plan lookup. */
export function historyWindowOpen(now: Date = windowClock.now()): boolean {
  return now.getTime() >= PURGE_NOT_BEFORE.getTime();
}

/**
 * The oldest instant that is still inside a window of `days`, or `null` for "no limit": before the not-before date, or when the
 * window is unlimited (`Infinity`, a deployment without plans: self-hosted keeps everything).
 */
export function historyWindowStart(days: number, now: Date = windowClock.now()): Date | null {
  if (!historyWindowOpen(now)) return null;
  if (!Number.isFinite(days)) return null;
  return new Date(now.getTime() - days * DAY_MS);
}
