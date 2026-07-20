import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { usageCounters } from '../db/schema';

/**
 * MN-194 — shared upsert-and-increment for the (workspaceId, periodStart, metric)
 * counter table that MN-168 (automation_runs, see entitlements.service.ts) and
 * MN-195 (record_writes_hourly, see abuse-flags.service.ts) already write to.
 * Extracted here so a THIRD metric (MN-194's `email_sends`, see
 * mail/email.service.ts) doesn't hand-roll its own copy of this upsert — the
 * shape (insert ... onConflictDoUpdate) is identical everywhere it's used;
 * only the period bucket and metric name differ. usage_counters itself needed
 * no schema change to support this — the table was already metric-generic.
 */
export async function incrementUsageCounter(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  metric: string,
  by = 1,
): Promise<number> {
  const [row] = await db
    .insert(usageCounters)
    .values({ workspaceId, periodStart, metric, count: by })
    .onConflictDoUpdate({
      target: [usageCounters.workspaceId, usageCounters.periodStart, usageCounters.metric],
      set: { count: sql`${usageCounters.count} + ${by}` },
    })
    .returning({ count: usageCounters.count });
  return row?.count ?? by;
}

/**
 * First-of-month UTC — the same monthly reset boundary EntitlementsService
 * uses for `automation_runs` (its own private `currentPeriodStart`).
 * Duplicated rather than imported to avoid a MailModule -> BillingModule
 * wiring edge for one three-line function; if the two ever drift, the fix is
 * here and in entitlements.service.ts, not in every metric writer.
 */
export function currentMonthPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The metric name MN-194 counts Resend sends under — see EmailService.send. */
export const EMAIL_SEND_METRIC = 'email_sends';

/** The metric name MN-168 counts non-AI automation runs under (mirrors entitlements.service.ts). */
export const AUTOMATION_RUN_METRIC = 'automation_runs';
