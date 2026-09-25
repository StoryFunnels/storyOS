import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, invites, memberships, user, views, workspaces } from '../db/schema';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';

type OnboardingMilestoneKey = 'guest_invited' | 'second_database' | 'form_published';

/**
 * #650 AC1 — how long a workspace gets before a missing milestone earns a
 * nudge. One window for all three: none of AC1's three triggers is more
 * time-sensitive than the others, and a single named constant is easier to
 * tune later than three independent guesses. Deliberately not a citation to
 * product research — this is a placeholder pending real activation-funnel
 * data (see the ticket comment); the mechanism (real milestone, real event,
 * atomic once-only send) is what AC4 requires, not this specific number.
 */
const ONBOARDING_NUDGE_WINDOW_DAYS = 3;

interface OnboardingMilestone {
  key: OnboardingMilestoneKey;
  sentAtColumn: PgColumn;
  /** True once the workspace no longer needs this nudge — either because it
   * reached the milestone, or because a later check makes an earlier one
   * moot. Claiming and delivering are both skipped when this is true. */
  reached: (db: Db, workspaceId: string) => Promise<boolean>;
  /** Claims this workspace's row for this milestone iff it hasn't fired yet —
   * same atomic UPDATE...WHERE...RETURNING shape as TrialRemindersService's
   * own `claim` (see its doc for why: only the tick whose UPDATE actually
   * matched a row proceeds to send). One explicit closure per milestone,
   * rather than a dynamic column name, so this stays type-checked. */
  claim: (db: Db, workspaceId: string) => Promise<boolean>;
  ctaPath: (slug: string) => string;
}

/**
 * #650 AC1 — onboarding-activation nudge emails, tied to real in-product
 * milestones rather than a generic "day N" drip (AC4). Mirrors
 * TrialRemindersService's shape deliberately (setInterval sweep, atomic
 * per-workspace claim via a dedicated sent-at column, best-effort delivery)
 * — the same mechanism this codebase already trusts for a proactive,
 * time-windowed email, just with a different set of milestones.
 *
 * The three milestones (guest invited, second database, public form) are the
 * exact ones the ticket names as "already shipped and unmeasured" (issues #2
 * and #3) plus the one universally-available structural signal (database
 * count) — not an invented activation funnel. Each `reached()` check queries
 * live state, the same discipline OnboardingController (#139/MN-213) already
 * applies to its own Getting-Started checklist: never a stored flag that can
 * drift from what's actually true.
 *
 * Deliberately email-only, no in-app notification: unlike a trial-expiry
 * warning (a problem the workspace needs to react to), this is a growth
 * nudge about something the workspace hasn't done — mixing "you haven't
 * tried X yet" into the same inbox as real activity notifications would be
 * exactly the "nagging SaaS" self-critique #3's own ticket already raised
 * about UI nudges, just relocated to a worse surface.
 */
@Injectable()
export class OnboardingNudgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingNudgeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private milestones(): OnboardingMilestone[] {
    return [
      {
        key: 'guest_invited',
        sentAtColumn: workspaces.onboardingNudgeGuestInvitedSentAt,
        // #3 — the milestone is the invite itself (the growth-loop moment),
        // not whether the guest has since accepted.
        reached: async (db, workspaceId) => {
          const [activeGuest] = await db
            .select({ one: sql`1` })
            .from(memberships)
            .where(
              and(
                eq(memberships.workspaceId, workspaceId),
                eq(memberships.role, 'guest'),
                eq(memberships.status, 'active'),
              ),
            )
            .limit(1);
          if (activeGuest) return true;
          const [pendingGuestInvite] = await db
            .select({ one: sql`1` })
            .from(invites)
            .where(and(eq(invites.workspaceId, workspaceId), eq(invites.role, 'guest'), isNull(invites.acceptedAt)))
            .limit(1);
          return Boolean(pendingGuestInvite);
        },
        claim: async (db, workspaceId) => {
          const [claimed] = await db
            .update(workspaces)
            .set({ onboardingNudgeGuestInvitedSentAt: new Date() })
            .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.onboardingNudgeGuestInvitedSentAt)))
            .returning({ id: workspaces.id });
          return Boolean(claimed);
        },
        ctaPath: (slug) => `/w/${slug}/settings/members?invite=guest`,
      },
      {
        key: 'second_database',
        sentAtColumn: workspaces.onboardingNudgeSecondDatabaseSentAt,
        // #128/#317: system databases are provisioned FOR the user, not BY
        // them — same exclusion OnboardingController's own checklist uses.
        reached: async (db, workspaceId) => {
          const rows = await db
            .select({ one: sql`1` })
            .from(databases)
            .where(and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, false)))
            .limit(2);
          return rows.length >= 2;
        },
        claim: async (db, workspaceId) => {
          const [claimed] = await db
            .update(workspaces)
            .set({ onboardingNudgeSecondDatabaseSentAt: new Date() })
            .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.onboardingNudgeSecondDatabaseSentAt)))
            .returning({ id: workspaces.id });
          return Boolean(claimed);
        },
        ctaPath: (slug) => `/w/${slug}`,
      },
      {
        key: 'form_published',
        sentAtColumn: workspaces.onboardingNudgeFormPublishedSentAt,
        // #2 — the growth loop is specifically the public FORM embed's
        // "Powered by StoryOS" badge; a form counts once it has a live
        // public token (config.form.public_token — same path forms.service.ts
        // mints and public-views.service.ts's sibling FormsService resolves).
        reached: async (db, workspaceId) => {
          const [published] = await db
            .select({ one: sql`1` })
            .from(views)
            .innerJoin(databases, eq(databases.id, views.databaseId))
            .where(
              and(
                eq(databases.workspaceId, workspaceId),
                eq(views.type, 'form'),
                sql`${views.config} -> 'form' ->> 'public_token' IS NOT NULL`,
              ),
            )
            .limit(1);
          return Boolean(published);
        },
        claim: async (db, workspaceId) => {
          const [claimed] = await db
            .update(workspaces)
            .set({ onboardingNudgeFormPublishedSentAt: new Date() })
            .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.onboardingNudgeFormPublishedSentAt)))
            .returning({ id: workspaces.id });
          return Boolean(claimed);
        },
        ctaPath: (slug) => `/w/${slug}`,
      },
    ];
  }

  /** One sweep pass — public so tests (and an overlapping/duplicate tick) can invoke it directly. */
  async sweep(): Promise<void> {
    for (const milestone of this.milestones()) {
      await this.sweepMilestone(milestone);
    }
  }

  private async sweepMilestone(milestone: OnboardingMilestone): Promise<void> {
    const cutoff = new Date(Date.now() - ONBOARDING_NUDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const candidates = await this.db
      .select({ id: workspaces.id, slug: workspaces.slug })
      .from(workspaces)
      .where(and(isNull(milestone.sentAtColumn), lt(workspaces.createdAt, cutoff)));

    for (const candidate of candidates) {
      try {
        if (await milestone.reached(this.db, candidate.id)) continue; // already there — never nag about it
        const claimed = await milestone.claim(this.db, candidate.id);
        if (!claimed) continue; // another tick already claimed this milestone
        await this.deliver(candidate.id, candidate.slug, milestone);
      } catch (error) {
        // Best-effort, like NotificationsService.notify / TrialRemindersService:
        // one workspace's failure must never stop the rest of the sweep.
        this.logger.warn(`onboarding nudge delivery failed for ${candidate.id} (${milestone.key}): ${String(error)}`);
      }
    }
  }

  private async deliver(workspaceId: string, slug: string, milestone: OnboardingMilestone): Promise<void> {
    const admins = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')),
    });
    if (admins.length === 0) return;

    const adminUsers = await this.db.query.user.findMany({ where: inArray(user.id, admins.map((m) => m.userId)) });
    if (adminUsers.length === 0) return;

    const ctaUrl = `${env().WEB_URL.replace(/\/$/, '')}${milestone.ctaPath(slug)}`;
    for (const admin of adminUsers) {
      await this.email.send(
        { kind: 'onboarding-nudge', to: admin.email, milestone: milestone.key, ctaUrl },
        workspaceId, // MN-194 — attributes this send's cost to the nudged workspace
      );
    }
  }
}
