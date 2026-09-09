import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { abuseFlags, usageCounters } from '../../db/schema';

/**
 * #353 — "measure spend per workspace from day one... an alert to us if any
 * single workspace crosses something obviously wrong in a day." Deliberately
 * NOT a spend control: this never blocks, throttles, or slows a turn down —
 * ticket #353's own ruling is that Tyron runs on StoryOS's key unmetered
 * until #352 (bring-your-own key) ships, and a dollar ceiling would be a
 * limit the product cannot show, explain, or let anyone raise. This exists
 * so that whenever a limit IS eventually needed, there is a number to pick
 * one from instead of a guess.
 *
 * Same shape as AbuseFlagsService.recordWrites (MN-195) on purpose — reusing
 * the existing generic usage_counters/abuse_flags tables rather than adding
 * a parallel metric-tracking mechanism for what is, structurally, the same
 * problem (count something per workspace per window, flag once if it
 * crosses a line). No migration needed: both tables were already shaped for
 * an arbitrary `metric` name and window granularity.
 */
export const TYRON_TOKENS_METRIC = 'tyron_tokens_daily';

/**
 * A generous, deliberately round daily-token threshold — chosen the same
 * way MN-195's RECORD_WRITE_HOURLY_THRESHOLD was: high enough that a real,
 * heavy day of chat use for one workspace should never cross it, so a flag
 * means something worth a human's attention rather than routine noise.
 * ~2,000,000 tokens/day is on the order of several hundred long turns in a
 * single workspace in one day — tunable, not a cap, and worth revisiting
 * once real usage data exists to compare it against.
 */
export const TYRON_TOKENS_DAILY_THRESHOLD = 2_000_000;

function currentDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * MN-195's fair-use guard, applied to Tyron token spend instead of record
 * writes. Detection-only: recordUsage() never throws and never affects the
 * turn that triggered it — callers fire-and-forget it, same convention as
 * every other post-write side effect in this codebase (domain events,
 * abuse flags, notifications).
 */
@Injectable()
export class TyronSpendGuardService {
  private readonly logger = new Logger(TyronSpendGuardService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Call after a Tyron turn completes with real token usage. Never throws. */
  async recordUsage(workspaceId: string, tokensIn: number, tokensOut: number): Promise<void> {
    const total = tokensIn + tokensOut;
    if (total <= 0) return;
    const windowStart = currentDayStart();

    const [row] = await this.db
      .insert(usageCounters)
      .values({ workspaceId, periodStart: windowStart, metric: TYRON_TOKENS_METRIC, count: total })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.periodStart, usageCounters.metric],
        set: { count: sql`${usageCounters.count} + ${total}` },
      })
      .returning({ count: usageCounters.count });

    const dayTotal = row?.count ?? total;
    if (dayTotal < TYRON_TOKENS_DAILY_THRESHOLD) return;

    const flagged = await this.db
      .insert(abuseFlags)
      .values({
        workspaceId,
        metric: TYRON_TOKENS_METRIC,
        windowStart,
        value: dayTotal,
        threshold: TYRON_TOKENS_DAILY_THRESHOLD,
      })
      .onConflictDoNothing()
      .returning({ id: abuseFlags.id });

    // Only the turn that FIRST crosses the line flags — every later turn that
    // day hits the unique constraint and no-ops, so this fires once per
    // workspace per day, not once per turn.
    if (flagged.length > 0) {
      this.logger.warn(
        `Tyron spend flag: workspace ${workspaceId} used ${dayTotal} tokens today ` +
          `(threshold ${TYRON_TOKENS_DAILY_THRESHOLD}). Not throttled — for human review.`,
      );
    }
  }
}
