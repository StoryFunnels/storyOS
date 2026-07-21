import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  aiCreditBalances,
  aiCreditTransactions,
  billingCustomers,
  memberships,
  user,
  workspaces,
} from '../db/schema';
import { env } from '../config/env';
import { StripeService } from './stripe.service';
import { AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES, AI_CREDIT_MIN_TOPUP_USD, creditExpiryDate } from './plans';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../mail/email.service';

export interface AiCreditBalance {
  balanceCents: number;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: number | null;
  autoReloadAmountCents: number | null;
}

const ZERO_BALANCE: AiCreditBalance = {
  balanceCents: 0,
  autoReloadEnabled: false,
  autoReloadThresholdCents: null,
  autoReloadAmountCents: null,
};

/** Outcome of a single auto-reload attempt — callers (recordUsage's inline
 * trigger, AutoReloadRetryService's sweep) use this to decide whether to log
 * or just move on; the notify-on-failure side effect already happened by the
 * time this returns (see notifyReloadOutcome). */
export type AutoReloadOutcome = 'skipped' | 'succeeded' | 'retrying' | 'disabled';

/**
 * MN-189 — StoryOS AI prepaid credits: a balance + append-only ledger, NOT a
 * subscription line (it exists independent of plan, per MN-107 — the add-on
 * works on Free too). The only place StoryOS ever bills AI; a your-own-AI run
 * (MN-188) has no code path that reaches anything in this file.
 *
 * Deliberately does NOT depend on BillingService, even though both need "find
 * or create the workspace's Stripe customer": BillingService.applyEvent will
 * need to call INTO this service for the top-up webhook, so a dependency the
 * other way would be circular. ensureCustomer here is a small, intentional
 * duplicate of BillingService's — cheaper than a circular service edge.
 *
 * MN-189 follow-up (#265) adds two things this file's original pass
 * deliberately deferred:
 *  - 12-month credit expiry (creditExpiryDate/expiresAt/remainingCents),
 *    checked lazily in expireStaleCredits rather than via a cron sweep.
 *  - Auto-reload's actual off-session charge (tryAutoReload and friends),
 *    with a claim-then-act mutex (autoReloadClaimedAt) for concurrency safety
 *    and a documented retry-then-disable policy for failures.
 */
@Injectable()
export class AiCreditsService {
  private readonly logger = new Logger(AiCreditsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stripe: StripeService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  private async ensureCustomer(workspaceId: string): Promise<string> {
    const existing = await this.db.query.billingCustomers.findFirst({
      where: eq(billingCustomers.workspaceId, workspaceId),
    });
    if (existing) return existing.stripeCustomerId;

    const workspace = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');

    const customer = await this.stripe.client.customers.create({
      name: workspace.name,
      metadata: { workspaceId, workspaceSlug: workspace.slug },
    });
    await this.db
      .insert(billingCustomers)
      .values({ workspaceId, stripeCustomerId: customer.id })
      .onConflictDoNothing();
    const row = await this.db.query.billingCustomers.findFirst({
      where: eq(billingCustomers.workspaceId, workspaceId),
    });
    return row?.stripeCustomerId ?? customer.id;
  }

  async getBalance(workspaceId: string): Promise<AiCreditBalance> {
    return this.db.transaction(async (tx) => {
      const expired = await this.expireStaleCredits(tx as unknown as Db, workspaceId, new Date());
      const row = await tx.query.aiCreditBalances.findFirst({
        where: eq(aiCreditBalances.workspaceId, workspaceId),
      });
      if (!row) return ZERO_BALANCE;
      return {
        // Prefer the balance expireStaleCredits just computed over a fresh
        // read: it already forfeited whatever was stale in this same
        // transaction, and re-reading here would just echo the pre-forfeit
        // snapshot back (the row read above is only needed for the other
        // auto-reload fields, which expiry never touches).
        balanceCents: expired?.balanceCents ?? row.balanceCents,
        autoReloadEnabled: row.autoReloadEnabled,
        autoReloadThresholdCents: row.autoReloadThresholdCents,
        autoReloadAmountCents: row.autoReloadAmountCents,
      };
    });
  }

  /** The card gate (MN-189 AC): a saved payment method, checked via Stripe, not assumed. */
  async hasPaymentMethod(workspaceId: string): Promise<boolean> {
    if (!this.stripe.enabled) return false;
    const existing = await this.db.query.billingCustomers.findFirst({
      where: eq(billingCustomers.workspaceId, workspaceId),
    });
    if (!existing) return false; // never even started a Stripe relationship
    const customer = await this.stripe.client.customers.retrieve(existing.stripeCustomerId);
    if (customer.deleted) return false;
    return Boolean(customer.invoice_settings?.default_payment_method);
  }

  /**
   * A one-time Checkout session (mode: 'payment', NOT 'subscription') — MN-189
   * is explicit that credits are never a recurring price. setup_future_usage
   * saves the card for auto-reload and doubles as satisfying the card gate.
   */
  async createTopUpSession(workspaceId: string, amountUsd: number): Promise<string> {
    if (!Number.isFinite(amountUsd) || amountUsd < AI_CREDIT_MIN_TOPUP_USD) {
      throw new BadRequestException(`Minimum top-up is $${AI_CREDIT_MIN_TOPUP_USD}.`);
    }
    const customer = await this.ensureCustomer(workspaceId);
    const session = await this.stripe.client.checkout.sessions.create({
      mode: 'payment',
      customer,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'StoryOS AI credits' },
            unit_amount: Math.round(amountUsd * 100),
          },
          quantity: 1,
        },
      ],
      payment_intent_data: { setup_future_usage: 'off_session' },
      success_url: `${env().WEB_URL}/settings/billing?status=credits_success`,
      cancel_url: `${env().WEB_URL}/settings/billing?status=credits_canceled`,
      metadata: { workspaceId, kind: 'ai_credit_topup' },
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
    return session.url;
  }

  /**
   * Credits the balance from a completed one-time payment — a manual Checkout
   * top-up OR an auto-reload charge (chargeReload calls this too). Idempotent
   * via the payment_intent id's unique constraint — a duplicate webhook
   * delivery (or a retried Stripe call landing twice) inserts nothing and the
   * balance is untouched. Called by BillingService.applyEvent for
   * checkout.session.completed, mode=payment.
   *
   * `expiresAt`/`remainingCents` (#265): every top-up expires 12 months from
   * now, tracked with its own FIFO remainder — see expireStaleCredits and
   * consumeTopUpsFifo.
   */
  async applyTopUp(workspaceId: string, amountCents: number, paymentIntentId: string): Promise<void> {
    const expiresAt = creditExpiryDate(new Date());
    const claimed = await this.db
      .insert(aiCreditTransactions)
      .values({
        workspaceId,
        type: 'top_up',
        amountCents,
        stripePaymentIntentId: paymentIntentId,
        expiresAt,
        remainingCents: amountCents,
      })
      .onConflictDoNothing()
      .returning({ id: aiCreditTransactions.id });
    if (claimed.length === 0) return; // already applied

    await this.db
      .insert(aiCreditBalances)
      .values({ workspaceId, balanceCents: amountCents })
      .onConflictDoUpdate({
        target: aiCreditBalances.workspaceId,
        set: { balanceCents: sql`${aiCreditBalances.balanceCents} + ${amountCents}` },
      });
  }

  /**
   * The hard stop (MN-189 AC): "the feature simply turns off, it never
   * overdrafts and never silently bills." This is the seam ManagedAiRuntime
   * (MN-214r, still a stub) will call before it does anything real.
   */
  async canUseManagedAi(workspaceId: string): Promise<boolean> {
    if (!this.stripe.enabled) return false;
    if (!(await this.hasPaymentMethod(workspaceId))) return false;
    const { balanceCents } = await this.getBalance(workspaceId);
    return balanceCents > 0;
  }

  /**
   * Debits the balance for one run and writes its cost-attribution ledger
   * row. Clamped at zero — never overdrafts, matching canUseManagedAi's
   * promise (callers are expected to check that first; this defends the
   * invariant regardless).
   *
   * #265 adds two things to the original debit-only version:
   *  - lazy expiry (expireStaleCredits) runs first, so the balance this debit
   *    reads is never inflated by credit that's already past its 12 months;
   *  - a FIFO write-down of which top-up(s) the debit came from
   *    (consumeTopUpsFifo), so expiry has something accurate to check later;
   *  - if the debit crosses the workspace's auto-reload threshold, a reload
   *    attempt is fired after the transaction commits (never inside it — a
   *    Stripe call has no place holding a DB transaction open).
   */
  async recordUsage(
    workspaceId: string,
    input: { tokensIn: number; tokensOut: number; ourCostCents: number; creditsChargedCents: number },
  ): Promise<void> {
    let shouldAttemptReload = false;

    await this.db.transaction(async (tx) => {
      const expired = await this.expireStaleCredits(tx as unknown as Db, workspaceId, new Date());

      const row = await tx.query.aiCreditBalances.findFirst({
        where: eq(aiCreditBalances.workspaceId, workspaceId),
      });
      // Same reasoning as getBalance: if expiry just forfeited part of the
      // balance, that's the current truth — a fresh read of `row` here would
      // otherwise be racing/echoing the pre-forfeit value.
      const current = expired?.balanceCents ?? row?.balanceCents ?? 0;
      const next = Math.max(0, current - input.creditsChargedCents);
      const consumed = current - next;

      await tx
        .insert(aiCreditBalances)
        .values({ workspaceId, balanceCents: next })
        .onConflictDoUpdate({ target: aiCreditBalances.workspaceId, set: { balanceCents: next } });

      await tx.insert(aiCreditTransactions).values({
        workspaceId,
        type: 'usage',
        amountCents: -input.creditsChargedCents,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        ourCostCents: input.ourCostCents,
      });

      if (consumed > 0) {
        await this.consumeTopUpsFifo(tx as unknown as Db, workspaceId, consumed);
      }

      shouldAttemptReload =
        Boolean(row?.autoReloadEnabled) &&
        row?.autoReloadThresholdCents != null &&
        next <= row.autoReloadThresholdCents;
    });

    if (shouldAttemptReload) {
      // A reload failing (or even erroring unexpectedly) must never fail the
      // run that triggered it — the debit above already committed.
      try {
        await this.tryAutoReload(workspaceId);
      } catch (error) {
        this.logger.error(`Auto-reload attempt errored for workspace ${workspaceId}: ${String(error)}`);
      }
    }
  }

  /**
   * Lazy 12-month expiry (#265): forfeits whatever is left of any top-up
   * whose `expiresAt` has passed, decrementing the balance by exactly that
   * remainder and logging an `adjustment` ledger row so the forfeiture is
   * visible in the ledger, not silent. Runs first thing inside both
   * getBalance() and recordUsage()'s transaction. There is deliberately no
   * scheduled sweep for this — checking at read/consumption time is the
   * simplest correct option given this ledger has no cron infra of its own to
   * hang one off (contrast AutoReloadRetryService below, which DOES need a
   * timer because a failed reload must be retried even if nobody reads the
   * balance in the meantime).
   */
  private async expireStaleCredits(
    tx: Db,
    workspaceId: string,
    now: Date,
  ): Promise<{ balanceCents: number } | null> {
    const stale = await tx.query.aiCreditTransactions.findMany({
      where: and(
        eq(aiCreditTransactions.workspaceId, workspaceId),
        eq(aiCreditTransactions.type, 'top_up'),
        isNotNull(aiCreditTransactions.expiresAt),
        lte(aiCreditTransactions.expiresAt, now),
        gt(aiCreditTransactions.remainingCents, 0),
      ),
    });
    if (stale.length === 0) return null;

    const forfeitedCents = stale.reduce((sum, row) => sum + (row.remainingCents ?? 0), 0);
    if (forfeitedCents <= 0) return null;

    await tx
      .update(aiCreditTransactions)
      .set({ remainingCents: 0 })
      .where(
        inArray(
          aiCreditTransactions.id,
          stale.map((row) => row.id),
        ),
      );

    const balanceRow = await tx.query.aiCreditBalances.findFirst({
      where: eq(aiCreditBalances.workspaceId, workspaceId),
    });
    const current = balanceRow?.balanceCents ?? 0;
    const next = Math.max(0, current - forfeitedCents);
    await tx
      .insert(aiCreditBalances)
      .values({ workspaceId, balanceCents: next })
      .onConflictDoUpdate({ target: aiCreditBalances.workspaceId, set: { balanceCents: next } });

    await tx.insert(aiCreditTransactions).values({
      workspaceId,
      type: 'adjustment',
      amountCents: -forfeitedCents,
    });

    return { balanceCents: next };
  }

  /**
   * Writes down `remainingCents` on the oldest still-live top-up(s) first, by
   * `consumedCents` (the amount a usage debit actually took off the balance —
   * already clamped by recordUsage, so it's never more than what's really
   * there). This is bookkeeping FOR EXPIRY ONLY: the aggregate
   * `balanceCents` column remains the sole source of truth for spending
   * power. If `consumedCents` exceeds what's tracked across top-up rows (e.g.
   * some of the balance came from a manual `adjustment` rather than a
   * top-up), the remainder is simply left untracked — there's nothing to
   * write down and nothing incorrect results, since expiry only ever acts on
   * rows that still have `remainingCents`.
   */
  private async consumeTopUpsFifo(tx: Db, workspaceId: string, consumedCents: number): Promise<void> {
    let remaining = consumedCents;
    const topUps = await tx.query.aiCreditTransactions.findMany({
      where: and(
        eq(aiCreditTransactions.workspaceId, workspaceId),
        eq(aiCreditTransactions.type, 'top_up'),
        gt(aiCreditTransactions.remainingCents, 0),
      ),
      orderBy: asc(aiCreditTransactions.createdAt),
    });

    for (const topUp of topUps) {
      if (remaining <= 0) break;
      const available = topUp.remainingCents ?? 0;
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      await tx
        .update(aiCreditTransactions)
        .set({ remainingCents: available - take })
        .where(eq(aiCreditTransactions.id, topUp.id));
      remaining -= take;
    }
  }

  async setAutoReload(
    workspaceId: string,
    input: { enabled: boolean; thresholdCents?: number; amountCents?: number },
  ): Promise<void> {
    if (input.enabled && (!input.thresholdCents || !input.amountCents)) {
      throw new BadRequestException('Auto-reload needs both a threshold and a top-up amount.');
    }
    if (input.amountCents !== undefined && input.amountCents < AI_CREDIT_MIN_TOPUP_USD * 100) {
      throw new BadRequestException(`Auto-reload amount must be at least $${AI_CREDIT_MIN_TOPUP_USD}.`);
    }
    await this.db
      .insert(aiCreditBalances)
      .values({
        workspaceId,
        autoReloadEnabled: input.enabled,
        autoReloadThresholdCents: input.thresholdCents ?? null,
        autoReloadAmountCents: input.amountCents ?? null,
        // Re-enabling (or re-configuring) auto-reload after a prior
        // disablement/backoff starts the retry state clean — a workspace
        // that fixes its card and flips this back on shouldn't inherit a
        // stale failure count or backoff timer from before. Set on both the
        // insert path (a workspace configuring auto-reload for the very
        // first time) and the conflict path below, so the row is clean
        // either way.
        autoReloadFailureCount: 0,
        autoReloadNextRetryAt: null,
      })
      .onConflictDoUpdate({
        target: aiCreditBalances.workspaceId,
        set: {
          autoReloadEnabled: input.enabled,
          autoReloadThresholdCents: input.thresholdCents ?? null,
          autoReloadAmountCents: input.amountCents ?? null,
          autoReloadFailureCount: 0,
          autoReloadNextRetryAt: null,
        },
      });
  }

  /**
   * Attempt an off-session auto-reload charge for a workspace, if one is due.
   * Public so both recordUsage (immediately, on threshold crossing) and
   * AutoReloadRetryService's sweep (on the backoff schedule) can call it
   * through the exact same claim-then-charge path.
   *
   * Concurrency (#265 AC: "two runs crossing the threshold in the same
   * moment must not double-charge"): the claim below is a single atomic
   * `UPDATE ... WHERE auto_reload_claimed_at IS NULL ... RETURNING`, the same
   * shape TrialRemindersService uses for its sentAt columns and
   * BillingService.applyEvent uses for webhook ids. Only the caller whose
   * UPDATE actually matched a row (the column was still NULL) proceeds to
   * call Stripe; every other concurrent caller's WHERE clause matches
   * nothing and it returns 'skipped'. That holds even if two `recordUsage`
   * transactions commit at the same instant, because the claim UPDATE is one
   * atomic statement.
   *
   * The same claim also gates retries: `autoReloadNextRetryAt` must be NULL
   * or already past, so a burst of usage while a backoff is in effect can't
   * hammer Stripe faster than the documented policy allows.
   */
  async tryAutoReload(workspaceId: string): Promise<AutoReloadOutcome> {
    const claimedAt = new Date();
    const claim = await this.db
      .update(aiCreditBalances)
      .set({ autoReloadClaimedAt: claimedAt })
      .where(
        and(
          eq(aiCreditBalances.workspaceId, workspaceId),
          eq(aiCreditBalances.autoReloadEnabled, true),
          isNull(aiCreditBalances.autoReloadClaimedAt),
          or(isNull(aiCreditBalances.autoReloadNextRetryAt), lte(aiCreditBalances.autoReloadNextRetryAt, claimedAt)),
        ),
      )
      .returning({
        amountCents: aiCreditBalances.autoReloadAmountCents,
        failureCount: aiCreditBalances.autoReloadFailureCount,
      });

    if (claim.length === 0) return 'skipped'; // already in flight, disabled, or backoff not elapsed

    const amountCents = claim[0]!.amountCents;
    if (!amountCents) {
      // Shouldn't happen (setAutoReload requires an amount to enable), but
      // never charge an unconfigured amount — just release the claim.
      await this.clearReloadClaim(workspaceId);
      return 'skipped';
    }

    try {
      await this.chargeReload(workspaceId, amountCents, claimedAt);
      await this.onReloadSuccess(workspaceId);
      return 'succeeded';
    } catch (error) {
      return this.onReloadFailure(workspaceId, claim[0]!.failureCount, error);
    }
  }

  /**
   * Fires the actual off-session PaymentIntent. Consistent with the existing
   * top-up flow's card handling (createTopUpSession's
   * `setup_future_usage: 'off_session'`): we charge the same saved default
   * payment method that flow captured, and rely on Stripe to tell us — via a
   * thrown card error — when a card can't be charged frictionlessly
   * off-session (expired, needs SCA/3DS re-authentication, straight decline,
   * etc). We don't attempt to handle SCA ourselves (there is no synchronous
   * way to complete a 3DS challenge off-session); a charge that comes back
   * `requires_action` is treated as a failure like any other and falls into
   * the same retry/notify policy — the customer resolves it by returning to
   * billing and topping up manually (which re-confirms the card), same as
   * any other failed reload.
   *
   * The idempotency key ties to this specific claim (workspace + claim
   * timestamp) so a network retry of this exact call can't double-charge;
   * it's deliberately NOT reused across separate claims/attempts (each
   * backoff retry is its own claim, and should be its own charge attempt).
   */
  private async chargeReload(workspaceId: string, amountCents: number, claimedAt: Date): Promise<void> {
    const customerId = await this.ensureCustomer(workspaceId);
    const customer = await this.stripe.client.customers.retrieve(customerId);
    if (customer.deleted) {
      throw new Error('Stripe customer was deleted — cannot charge off-session.');
    }
    const paymentMethod = customer.invoice_settings?.default_payment_method;
    if (!paymentMethod) {
      throw new Error('No default payment method on file for off-session charging.');
    }
    const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod.id;

    const paymentIntent = await this.stripe.client.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { workspaceId, kind: 'ai_credit_auto_reload' },
      },
      { idempotencyKey: `ai-credit-reload:${workspaceId}:${claimedAt.getTime()}` },
    );

    await this.applyTopUp(workspaceId, amountCents, paymentIntent.id);
  }

  private async clearReloadClaim(workspaceId: string): Promise<void> {
    await this.db
      .update(aiCreditBalances)
      .set({ autoReloadClaimedAt: null })
      .where(eq(aiCreditBalances.workspaceId, workspaceId));
  }

  private async onReloadSuccess(workspaceId: string): Promise<void> {
    await this.db
      .update(aiCreditBalances)
      .set({ autoReloadClaimedAt: null, autoReloadFailureCount: 0, autoReloadNextRetryAt: null })
      .where(eq(aiCreditBalances.workspaceId, workspaceId));
  }

  /**
   * The documented retry policy (#265 AC): up to
   * env().AI_CREDIT_AUTO_RELOAD_MAX_ATTEMPTS consecutive failures, backing
   * off per AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES (1h/6h/24h) between each —
   * not unbounded. Once exhausted, auto-reload is disabled outright (rather
   * than left silently retrying forever) and the workspace is notified so a
   * human replaces the card. Every failure (not just the terminal one) is
   * surfaced via an in-app notification; only the terminal "disabled" outcome
   * also sends an email, so a single transient decline that will retry within
   * the hour doesn't inbox-spam the workspace.
   */
  private async onReloadFailure(
    workspaceId: string,
    previousFailureCount: number,
    error: unknown,
  ): Promise<AutoReloadOutcome> {
    const failureCount = previousFailureCount + 1;
    const maxAttempts = env().AI_CREDIT_AUTO_RELOAD_MAX_ATTEMPTS;
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Auto-reload charge failed for workspace ${workspaceId} (attempt ${failureCount}/${maxAttempts}): ${reason}`,
    );

    if (failureCount >= maxAttempts) {
      await this.db
        .update(aiCreditBalances)
        .set({
          autoReloadEnabled: false,
          autoReloadClaimedAt: null,
          autoReloadFailureCount: failureCount,
          autoReloadNextRetryAt: null,
        })
        .where(eq(aiCreditBalances.workspaceId, workspaceId));
      await this.notifyReloadOutcome(workspaceId, 'disabled', reason);
      return 'disabled';
    }

    const backoffMinutes =
      AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES[
        Math.min(failureCount - 1, AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES.length - 1)
      ]!;
    const nextRetryAt = new Date(Date.now() + backoffMinutes * 60_000);
    await this.db
      .update(aiCreditBalances)
      .set({ autoReloadClaimedAt: null, autoReloadFailureCount: failureCount, autoReloadNextRetryAt: nextRetryAt })
      .where(eq(aiCreditBalances.workspaceId, workspaceId));
    await this.notifyReloadOutcome(workspaceId, 'retrying', reason);
    return 'retrying';
  }

  /** Same admin-audience shape as TrialRemindersService.deliver — billing is
   * admin-only (AiCreditsController's @MinRole('admin')), so the reminder
   * goes to the same audience that can act on it. */
  private async notifyReloadOutcome(
    workspaceId: string,
    outcome: 'retrying' | 'disabled',
    reason: string,
  ): Promise<void> {
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
    const billingUrl = `${env().WEB_URL.replace(/\/$/, '')}/w/${workspace?.slug ?? ''}/settings/billing`;
    const snippet =
      outcome === 'disabled'
        ? `Auto-reload for ${workspaceName} failed repeatedly and has been turned off: ${reason}`
        : `An auto-reload charge for ${workspaceName} failed and will be retried: ${reason}`;

    await this.notifications.notify({
      workspaceId,
      actorId: 'system',
      type: 'auto_reload_failed',
      recipients: adminUsers.map((u) => u.id),
      snippet,
    });

    if (outcome === 'disabled') {
      for (const admin of adminUsers) {
        await this.email.send({ kind: 'auto-reload-failed', to: admin.email, workspaceName, billingUrl });
      }
    }
  }
}
