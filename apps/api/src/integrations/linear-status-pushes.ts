/**
 * Ticket #1390 - what the status outbox (`linear_status_pushes`) looks like from outside: counts per team and the rows that need a
 * person. Shared by the Linear settings payload, the Preview, the sync summary and the ownership read, so each says the same thing.
 * Counts and record numbers only: never a title, a body or the Linear key. `last_error` was redacted when it was stored.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { linearStatusPushes, records } from '../db/schema';

export interface StatusPushCounts {
  /** Waiting to be sent or in flight. */
  pending: number;
  /** Dead letters: every retry was used and Linear never accepted it. Needs a person (switch the team's write-back off and on to retry). */
  failed: number;
  /** The StoryOS status has no Linear state of that name in the team's workflow: never guessed, never written. Needs a person. */
  unmapped: number;
  last_error: string | null;
}

export interface StatusPushFailure {
  record_id: string;
  record_number: number | null;
  team_key: string;
  status: 'failed' | 'unmapped';
  target_label: string;
  attempts: number;
  error: string | null;
}

const noCounts = (): StatusPushCounts => ({ pending: 0, failed: 0, unmapped: 0, last_error: null });

export async function statusPushCounts(db: Db, workspaceId: string): Promise<{ total: StatusPushCounts; by_team: Record<string, StatusPushCounts> }> {
  const rows = await db
    .select({ team: linearStatusPushes.teamKey, status: linearStatusPushes.status, n: sql<number>`count(*)::int`, lastError: sql<string | null>`max(${linearStatusPushes.lastError})` })
    .from(linearStatusPushes)
    .where(eq(linearStatusPushes.workspaceId, workspaceId))
    .groupBy(linearStatusPushes.teamKey, linearStatusPushes.status);
  const by_team: Record<string, StatusPushCounts> = {};
  const total = noCounts();
  for (const row of rows) {
    const mine = (by_team[row.team] ??= noCounts());
    const bucket = row.status === 'pending' || row.status === 'sending' ? 'pending' : row.status === 'failed' ? 'failed' : row.status === 'unmapped' ? 'unmapped' : null;
    if (!bucket) continue;
    mine[bucket] += row.n;
    total[bucket] += row.n;
    // A settled problem (failed/unmapped) outranks the error of something still retrying.
    if (row.lastError && (bucket !== 'pending' || !mine.last_error)) mine.last_error = row.lastError;
    if (row.lastError && (bucket !== 'pending' || !total.last_error)) total.last_error = row.lastError;
  }
  return { total, by_team };
}

/** The rows an admin has to act on, oldest first, capped. */
export async function statusPushFailures(db: Db, workspaceId: string, limit = 20): Promise<StatusPushFailure[]> {
  const rows = await db
    .select({
      recordId: linearStatusPushes.recordId, number: records.number, team: linearStatusPushes.teamKey, status: linearStatusPushes.status,
      label: linearStatusPushes.targetLabel, attempts: linearStatusPushes.attempts, error: linearStatusPushes.lastError,
    })
    .from(linearStatusPushes)
    .leftJoin(records, eq(records.id, linearStatusPushes.recordId))
    .where(and(eq(linearStatusPushes.workspaceId, workspaceId), inArray(linearStatusPushes.status, ['failed', 'unmapped'])))
    .orderBy(asc(linearStatusPushes.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ record_id: r.recordId, record_number: r.number ?? null, team_key: r.team, status: r.status as 'failed' | 'unmapped', target_label: r.label, attempts: r.attempts, error: r.error }));
}
