import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { aiCreditBalances } from '../db/schema';
import { env } from '../config/env';
import { AiCreditsService } from './ai-credits.service';

/**
 * MN-189 follow-up (#265) — the other half of the auto-reload retry policy.
 * AiCreditsService.tryAutoReload already runs synchronously the instant
 * usage crosses the threshold (see recordUsage); that covers the common
 * case. But once a workspace's balance hits zero, the hard stop
 * (canUseManagedAi) blocks further runs — so if a reload attempt failed and
 * is backing off (autoReloadNextRetryAt in the future), nothing will ever
 * call recordUsage again to give it a second try. This sweep is what picks
 * those up: same `setInterval` polling shape TrialRemindersService (#263)
 * already established for day-23/day-29 reminders, rather than introducing a
 * new job-scheduling mechanism for one more periodic check.
 *
 * Correctness doesn't depend on this sweep's timing: tryAutoReload's own
 * atomic claim (autoReloadClaimedAt) is what actually prevents a double
 * charge, so an overlapping tick, a slow tick, or one that fires early is
 * harmless — it just finds the claim already held (or the retry not yet due)
 * and no-ops for that workspace, exactly like an overlapping recordUsage
 * call would.
 */
@Injectable()
export class AutoReloadRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoReloadRetryService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aiCredits: AiCreditsService,
  ) {}

  onModuleInit() {
    // The shortest backoff step (AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES) is an
    // hour; a 15-minute tick gives that plenty of resolution without being a
    // wasteful poll.
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.sweep(), 15 * 60 * 1000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep pass — public so tests (and an overlapping/duplicate tick) can invoke it directly. */
  async sweep(): Promise<void> {
    const now = new Date();
    const candidates = await this.db.query.aiCreditBalances.findMany({
      where: and(
        eq(aiCreditBalances.autoReloadEnabled, true),
        isNull(aiCreditBalances.autoReloadClaimedAt),
        isNotNull(aiCreditBalances.autoReloadNextRetryAt),
        lte(aiCreditBalances.autoReloadNextRetryAt, now),
      ),
    });

    for (const row of candidates) {
      try {
        await this.aiCredits.tryAutoReload(row.workspaceId);
      } catch (error) {
        // Best-effort, like TrialRemindersService.sweepMilestone: one
        // workspace's failure must never stop the rest of the sweep.
        this.logger.warn(`auto-reload retry failed for ${row.workspaceId}: ${String(error)}`);
      }
    }
  }
}
