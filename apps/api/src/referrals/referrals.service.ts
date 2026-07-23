import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, referralCodes, referralRewardGrants, referralSignups } from '../db/schema';

/**
 * #33 — flat reward for a referred workspace's first-ever paid conversion.
 * A placeholder number (owner has not set a final figure), same honesty
 * pattern as STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS in billing/plans.ts:
 * tracked plainly rather than guessed at precision we don't have. This is an
 * INTERNAL ledger entry only (see applyEvent below) — nothing here touches a
 * real Stripe coupon, balance, or invoice.
 */
export const REFERRAL_REWARD_CENTS = 2000;

/** Unambiguous alphabet (no 0/O/1/I/L) — codes are read aloud/typed by humans. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateReferralCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

export interface ReferralSummary {
  code: string;
  link: string;
  signups: number;
  paidConversions: number;
  rewardCents: number;
}

/**
 * #33 — the cloud referral program. Per-user link (referral_codes), first-
 * touch attribution at sign-up (referral_signups), and a reward ledger
 * (referral_reward_grants) credited on a referred workspace's first-ever
 * paid conversion.
 *
 * Deliberately does NOT talk to Stripe: the reward is an internal balance a
 * human reviews before it ever reduces a real invoice (see the ticket's
 * explicit instruction against live coupon/promotion-code mutation). Turning
 * `sum(referral_reward_grants.amountCents)` into an actual Stripe balance
 * transaction/coupon application is deferred, flagged here rather than built:
 * a follow-up ticket owns that human-reviewed step.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Find-or-create this user's referral code. Racy inserts converge: a
   * losing insert (userId PK conflict, or the rarer code-uniqueness
   * conflict on a different user's row) no-ops and the retry re-reads. */
  async getOrCreateCode(userId: string): Promise<string> {
    const existing = await this.db.query.referralCodes.findFirst({
      where: eq(referralCodes.userId, userId),
    });
    if (existing) return existing.code;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateReferralCode();
      const inserted = await this.db
        .insert(referralCodes)
        .values({ userId, code })
        .onConflictDoNothing()
        .returning({ code: referralCodes.code });
      if (inserted.length > 0) return inserted[0]!.code;

      const raced = await this.db.query.referralCodes.findFirst({
        where: eq(referralCodes.userId, userId),
      });
      if (raced) return raced.code;
    }
    throw new Error('Could not generate a unique referral code — retries exhausted.');
  }

  /**
   * Attribute a referred sign-up. Called by the web app right after a new
   * account is created, with whatever code its first-touch cookie carried
   * (docs/architecture — signup page reads `so_ref`, posts it here, clears
   * the cookie either way). Unknown code and self-referral both silently
   * no-op — this is best-effort attribution, not a gate on signing up.
   * `onConflictDoNothing` on referee uniqueness makes a retry (or a second,
   * stale cookie post) harmless: only the FIRST attribution for a given
   * referee ever counts.
   */
  async attribute(refereeUserId: string, code: string): Promise<{ attributed: boolean }> {
    const codeRow = await this.db.query.referralCodes.findFirst({
      where: eq(referralCodes.code, code),
    });
    if (!codeRow || codeRow.userId === refereeUserId) return { attributed: false };

    const inserted = await this.db
      .insert(referralSignups)
      .values({ code: codeRow.code, referrerUserId: codeRow.userId, refereeUserId })
      .onConflictDoNothing()
      .returning({ id: referralSignups.id });
    return { attributed: inserted.length > 0 };
  }

  /**
   * Called by BillingService.reconcileSubscription when a workspace's plan
   * transitions off Free for the first time. Looks up the workspace's admins
   * (workspace creation always makes the creator an admin — WorkspacesService
   * .create) and rewards the referrer of whichever one was a referred
   * sign-up, if any and if not already converted. The
   * `WHERE convertedAt IS NULL` on the claiming UPDATE is the same
   * claim-then-act shape billing_events/trial reminders use — two concurrent
   * webhook deliveries for the same workspace can't both grant the reward.
   */
  async recordConversionIfEligible(workspaceId: string): Promise<void> {
    const admins = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin')),
    });
    if (admins.length === 0) return;

    const signup = await this.db.query.referralSignups.findFirst({
      where: and(
        inArray(
          referralSignups.refereeUserId,
          admins.map((a) => a.userId),
        ),
        isNull(referralSignups.convertedAt),
      ),
    });
    if (!signup) return;

    const claimed = await this.db
      .update(referralSignups)
      .set({ convertedAt: new Date() })
      .where(and(eq(referralSignups.id, signup.id), isNull(referralSignups.convertedAt)))
      .returning({ id: referralSignups.id });
    if (claimed.length === 0) return; // raced with another delivery — already claimed

    await this.db.insert(referralRewardGrants).values({
      signupId: signup.id,
      referrerUserId: signup.referrerUserId,
      amountCents: REFERRAL_REWARD_CENTS,
      reason: 'paid_conversion',
    });
    this.logger.log(
      `Referral reward granted: ${REFERRAL_REWARD_CENTS}c to ${signup.referrerUserId} (workspace ${workspaceId} converted).`,
    );
  }

  /** Everything the Settings → Referrals page needs in one call. */
  async getSummary(userId: string, webUrl: string): Promise<ReferralSummary> {
    const code = await this.getOrCreateCode(userId);
    const signups = await this.db.query.referralSignups.findMany({
      where: eq(referralSignups.referrerUserId, userId),
    });
    const grants = await this.db.query.referralRewardGrants.findMany({
      where: eq(referralRewardGrants.referrerUserId, userId),
    });
    return {
      code,
      link: `${webUrl}/signup?ref=${code}`,
      signups: signups.length,
      paidConversions: signups.filter((s) => s.convertedAt !== null).length,
      rewardCents: grants.reduce((sum, g) => sum + g.amountCents, 0),
    };
  }
}
