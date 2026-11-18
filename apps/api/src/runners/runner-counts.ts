import { and, eq, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { runners } from '../db/schema';
import { RUNNER_OFFLINE_AFTER_MS } from './runner.constants';

/**
 * ticket #1320: the numbers behind "N Runners connected" in Settings, as ONE aggregate query over the caller's own rows (never a
 * count of a fetched page: the Tyron rule in CLAUDE.md). The predicates below are the SQL form of `isConnected` in
 * runner-present.ts and of the `paused_until` test `holdsFor` uses for `limit_reached`; test/runners-connected-count.test.ts holds
 * the two forms equal, at the window edge and on a mix of ages, against the rows the same request returns.
 */
export interface RunnerCounts {
  /** Your own Runners that are listed: pending and active (a removed one is not). Equals `data.length`. */
  total_count: number;
  /** Active and heard from within RUNNER_OFFLINE_AFTER_MS. */
  connected_count: number;
  /** Active and NOT heard from within the window. A pending Runner is in neither this nor `connected_count`. */
  offline_count: number;
  /** Active with its tool's limit still in force (`paused_until` in the future). Counted whether or not it is also offline. */
  at_limit_count: number;
  /** The warning colour: some Runner is offline or at its limit. Decided here so no screen re-derives it. */
  needs_attention: boolean;
}

const heardAt = sql`coalesce(${runners.lastSeenAt}, ${runners.activatedAt}, ${runners.createdAt})`;

/** Active and heard from at or after `now - window`: heard exactly one window ago is still connected, as `isConnected`. */
function connectedSql(now: Date): SQL {
  const cutoff = new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS);
  return sql`(${runners.status} = 'active' and ${heardAt} >= ${cutoff})`;
}

export async function runnerCounts(db: Db, workspaceId: string, userId: string, now: Date): Promise<RunnerCounts> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      connected: sql<number>`count(*) filter (where ${connectedSql(now)})`.mapWith(Number),
      offline: sql<number>`count(*) filter (where ${runners.status} = 'active' and not ${connectedSql(now)})`.mapWith(Number),
      atLimit: sql<number>`count(*) filter (where ${runners.status} = 'active' and ${runners.pausedUntil} > ${now})`.mapWith(Number),
    })
    .from(runners)
    .where(and(eq(runners.workspaceId, workspaceId), eq(runners.userId, userId), ne(runners.status, 'revoked')));
  if (!row) throw new Error('runner counts: an aggregate with no GROUP BY returned no row'); // cannot happen; says so rather than reporting a made-up zero
  return {
    total_count: row.total,
    connected_count: row.connected,
    offline_count: row.offline,
    at_limit_count: row.atLimit,
    needs_attention: row.offline > 0 || row.atLimit > 0,
  };
}
