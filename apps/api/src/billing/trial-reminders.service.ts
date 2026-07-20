import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { billingSubscriptions, memberships, user, workspaces } from '../db/schema';
import { env } from '../config/env';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationType } from '../notifications/notifications.service';
import { EmailService } from '../mail/email.service';

type MilestoneType = Extract<NotificationType, 'trial_reminder_23' | 'trial_reminder_29'>;

interface Milestone {
  /** Day into the (default 30-day) trial this reminder fires on. */
  day: number;
  sentAtColumn: PgColumn;
  type: MilestoneType;
  /** Claims this workspace's row for this milestone iff it hasn't fired yet.
   * Returns the claimed row(s) — empty means another sweep tick got there first. */
  claim: (workspaceId: string) => Promise<unknown[]>;
}

/**
 * Proactive trial-expiry reminders (#263). MN-192's `BillingService.getStatus()`
 * only downgrades a no-card trial to Free lazily, on the next read — a team
 * that never opens the billing page rides the trial silently to Free with no
 * warning. This sweep pushes a heads-up (in-app + email) at day 23 and day 29
 * of the trial instead, mirroring AutomationsService's `setInterval` polling
 * pattern rather than introducing a new job-scheduling mechanism.
 *
 * Idempotency: each (workspace, milestone) pair is claimed with an atomic
 * `UPDATE billing_subscriptions SET <sent_at column> = now() WHERE workspace_id
 * = ? AND <sent_at column> IS NULL RETURNING …` before anything is sent — the
 * same claim-then-act shape `BillingService.applyEvent` uses for webhook ids
 * via `billing_events`. Only the tick whose UPDATE actually matched a row (the
 * column was still NULL) proceeds to notify/email; a second, overlapping, or
 * post-restart sweep finds the column already set and its WHERE clause
 * matches nothing, so it silently no-ops. That holds even if two sweep ticks
 * run genuinely concurrently, because the claim is a single atomic statement.
 *
 * Never fires for a Stripe-backed subscription: candidates are restricted to
 * `stripeSubscriptionId IS NULL` — the same no-card-trial gate MN-192's lazy
 * check reads — so a real Stripe trial (owned by Stripe's own
 * `trial_will_end` webhook, see BillingService.applyEvent) is untouched.
 */
@Injectable()
export class TrialRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrialRemindersService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    // Day-granularity milestones don't need AutomationsService's 60s
    // resolution; hourly is plenty and cuts the idle-poll volume.
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private milestones(): Milestone[] {
    return [
      {
        day: 23,
        sentAtColumn: billingSubscriptions.trialReminder23SentAt,
        type: 'trial_reminder_23',
        claim: (workspaceId) =>
          this.db
            .update(billingSubscriptions)
            .set({ trialReminder23SentAt: new Date() })
            .where(
              and(
                eq(billingSubscriptions.workspaceId, workspaceId),
                isNull(billingSubscriptions.trialReminder23SentAt),
              ),
            )
            .returning({ workspaceId: billingSubscriptions.workspaceId }),
      },
      {
        day: 29,
        sentAtColumn: billingSubscriptions.trialReminder29SentAt,
        type: 'trial_reminder_29',
        claim: (workspaceId) =>
          this.db
            .update(billingSubscriptions)
            .set({ trialReminder29SentAt: new Date() })
            .where(
              and(
                eq(billingSubscriptions.workspaceId, workspaceId),
                isNull(billingSubscriptions.trialReminder29SentAt),
              ),
            )
            .returning({ workspaceId: billingSubscriptions.workspaceId }),
      },
    ];
  }

  /** One sweep pass — public so tests (and an overlapping/duplicate tick) can invoke it directly. */
  async sweep(): Promise<void> {
    for (const milestone of this.milestones()) {
      await this.sweepMilestone(milestone);
    }
  }

  private async sweepMilestone(milestone: Milestone): Promise<void> {
    const trialDays = env().BILLING_TRIAL_DAYS;
    const daysRemaining = trialDays - milestone.day;
    // The milestone is "reached" once trialEndsAt is within daysRemaining days
    // from now — i.e. the trial has been running for `milestone.day` days.
    const cutoff = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);

    const candidates = await this.db.query.billingSubscriptions.findMany({
      where: and(
        eq(billingSubscriptions.status, 'trialing'),
        // The no-card-trial gate (MN-192): a Stripe-backed trial has an id here
        // and must never be swept — reminders never fire for a paid/Stripe plan.
        isNull(billingSubscriptions.stripeSubscriptionId),
        isNotNull(billingSubscriptions.trialEndsAt),
        isNull(milestone.sentAtColumn),
        lte(billingSubscriptions.trialEndsAt, cutoff),
      ),
    });

    for (const row of candidates) {
      try {
        const claimed = await milestone.claim(row.workspaceId);
        if (claimed.length === 0) continue; // another tick already claimed this milestone
        await this.deliver(row.workspaceId, daysRemaining, milestone.type);
      } catch (error) {
        // Best-effort, like NotificationsService.notify: one workspace's
        // failure must never stop the rest of the sweep or the poll loop.
        this.logger.warn(`trial reminder delivery failed for ${row.workspaceId}: ${String(error)}`);
      }
    }
  }

  private async deliver(workspaceId: string, daysRemaining: number, type: MilestoneType): Promise<void> {
    const [workspace, admins] = await Promise.all([
      this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      this.db.query.memberships.findMany({
        where: and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.role, 'admin'),
          eq(memberships.status, 'active'),
        ),
      }),
    ]);
    if (admins.length === 0) return;

    const adminUsers = await this.db.query.user.findMany({
      where: inArray(user.id, admins.map((m) => m.userId)),
    });
    if (adminUsers.length === 0) return;

    const workspaceName = workspace?.name ?? 'your workspace';
    const dayWord = daysRemaining === 1 ? 'day' : 'days';
    const snippet = `Your Pro trial for ${workspaceName} ends in ${daysRemaining} ${dayWord}.`;
    const billingUrl = `${env().WEB_URL.replace(/\/$/, '')}/w/${workspace?.slug ?? ''}/settings/billing`;

    // Billing is admin-only (BillingController's @MinRole('admin')) — the
    // reminder goes to the same audience that can act on it.
    await this.notifications.notify({
      workspaceId,
      actorId: 'system',
      type,
      recipients: adminUsers.map((u) => u.id),
      snippet,
    });

    for (const admin of adminUsers) {
      await this.email.send({
        kind: 'trial-reminder',
        to: admin.email,
        workspaceName,
        daysRemaining,
        billingUrl,
      });
    }
  }
}
