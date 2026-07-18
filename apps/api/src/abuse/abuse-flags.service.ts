import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { abuseFlags, usageCounters } from '../db/schema';

/**
 * MN-195 — a generous, hourly write-rate threshold that flags a workspace
 * for HUMAN review, and does nothing else. Chosen deliberately high: a real
 * team doing heavy data entry, or even importing a large CSV in one sitting,
 * should never cross this. It exists to catch scraping/dumping/free-database
 * abuse, not to second-guess a legitimate power user. Tunable; not a cap.
 */
export const RECORD_WRITE_HOURLY_THRESHOLD = 10_000;
const RECORD_WRITES_METRIC = 'record_writes_hourly';

function currentHourStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}

/**
 * MN-195 — the fair-use guard for "no record limits, ever." Deliberately
 * detection-only: recordWrites() never throws, never blocks, never slows a
 * write down — it counts, and if a workspace crosses the threshold within an
 * hour, flags it once (idempotent via abuse_flags' unique constraint) for a
 * human to look at case-by-case. There is no code path anywhere from this
 * service back into the write itself.
 */
@Injectable()
export class AbuseFlagsService {
  private readonly logger = new Logger(AbuseFlagsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Call after a batch of records is successfully created. Never throws —
   * callers wrap this fire-and-forget; a broken abuse check must never break
   * a real user's write.
   */
  async recordWrites(workspaceId: string, count: number): Promise<void> {
    const windowStart = currentHourStart();
    const [row] = await this.db
      .insert(usageCounters)
      .values({ workspaceId, periodStart: windowStart, metric: RECORD_WRITES_METRIC, count })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.periodStart, usageCounters.metric],
        set: { count: sql`${usageCounters.count} + ${count}` },
      })
      .returning({ count: usageCounters.count });

    const total = row?.count ?? count;
    if (total < RECORD_WRITE_HOURLY_THRESHOLD) return;

    const flagged = await this.db
      .insert(abuseFlags)
      .values({
        workspaceId,
        metric: RECORD_WRITES_METRIC,
        windowStart,
        value: total,
        threshold: RECORD_WRITE_HOURLY_THRESHOLD,
      })
      .onConflictDoNothing()
      .returning({ id: abuseFlags.id });

    // Only the FIRST write in the hour that crosses the line actually flags —
    // every subsequent write that hour hits the unique constraint and no-ops,
    // so this log line (today's stand-in for MN-104's operator alert, which
    // doesn't exist yet) fires once per workspace per hour, not once per write.
    if (flagged.length > 0) {
      this.logger.warn(
        `Fair-use flag: workspace ${workspaceId} wrote ${total} records in the last hour ` +
          `(threshold ${RECORD_WRITE_HOURLY_THRESHOLD}). Not throttled — for human review.`,
      );
    }
  }

  /** MN-104's future admin panel reads this — unflagged, chronological. */
  async recentFlags(limit = 50) {
    return this.db.query.abuseFlags.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit,
    });
  }

  async flagsForWorkspace(workspaceId: string) {
    return this.db.query.abuseFlags.findMany({
      where: and(eq(abuseFlags.workspaceId, workspaceId)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }
}
