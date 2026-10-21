import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { approvals, automationRuns } from '../db/schema';
import { waitingApprovalCondition } from './approvals.service';

/**
 * #1009 / #1011 — a DERIVED status, defined once for EVERY endpoint that returns a run (the workspace run list and detail, and a single
 * rule's history): the run finished queueing its actions (stored `ok`) but at least one is gated on an approval nobody has decided. The run row is closed as `ok` the moment its actions are queued, so before this a run waiting for a person read `ok`, which
 * told the page "Succeeded" about something that had not happened. It is never stored: it is true exactly while an approval is waiting,
 * and flips back to `ok` the moment the last one is decided.
 *
 * The statuses the API speaks and the words the app shows: ok = Succeeded, error = Failed, running = Running, skipped = Skipped,
 * skipped_quota = Skipped (quota), awaiting_approval = Awaiting approval.
 */
export const AWAITING_APPROVAL = 'awaiting_approval';

/** `exists (a waiting approval for this run)` — correlated on the run being listed. */
export const hasWaitingApproval = (db: Db) =>
  exists(db.select({ one: sql`1` }).from(approvals).where(and(eq(approvals.runId, automationRuns.id), waitingApprovalCondition())));

/** How many waiting approvals each of these runs has (runs with none are absent from the map). */
export async function waitingCounts(db: Db, runIds: string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ runId: approvals.runId, n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(inArray(approvals.runId, runIds), waitingApprovalCondition()))
    .groupBy(approvals.runId);
  return new Map(rows.flatMap((r) => (r.runId ? [[r.runId, r.n] as const] : [])));
}

/** The status a caller sees: a finished-OK run with an approval still waiting is `awaiting_approval`; every other status is as stored. */
export const effectiveStatus = (stored: string, waiting: number): string => (stored === 'ok' && waiting > 0 ? AWAITING_APPROVAL : stored);

