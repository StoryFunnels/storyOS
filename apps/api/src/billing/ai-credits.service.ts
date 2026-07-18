import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { aiCreditBalances, aiCreditTransactions, billingCustomers, workspaces } from '../db/schema';
import { env } from '../config/env';
import { StripeService } from './stripe.service';
import { AI_CREDIT_MIN_TOPUP_USD } from './plans';

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
 */
@Injectable()
export class AiCreditsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stripe: StripeService,
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
    const row = await this.db.query.aiCreditBalances.findFirst({
      where: eq(aiCreditBalances.workspaceId, workspaceId),
    });
    if (!row) return ZERO_BALANCE;
    return {
      balanceCents: row.balanceCents,
      autoReloadEnabled: row.autoReloadEnabled,
      autoReloadThresholdCents: row.autoReloadThresholdCents,
      autoReloadAmountCents: row.autoReloadAmountCents,
    };
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
   * Credits the balance from a completed one-time payment. Idempotent via the
   * payment_intent id's unique constraint — a duplicate webhook delivery
   * inserts nothing and the balance is untouched. Called by
   * BillingService.applyEvent for checkout.session.completed, mode=payment.
   */
  async applyTopUp(workspaceId: string, amountCents: number, paymentIntentId: string): Promise<void> {
    const claimed = await this.db
      .insert(aiCreditTransactions)
      .values({ workspaceId, type: 'top_up', amountCents, stripePaymentIntentId: paymentIntentId })
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
   */
  async recordUsage(
    workspaceId: string,
    input: { tokensIn: number; tokensOut: number; ourCostCents: number; creditsChargedCents: number },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await tx.query.aiCreditBalances.findFirst({
        where: eq(aiCreditBalances.workspaceId, workspaceId),
      });
      const current = row?.balanceCents ?? 0;
      const next = Math.max(0, current - input.creditsChargedCents);

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
    });
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
      })
      .onConflictDoUpdate({
        target: aiCreditBalances.workspaceId,
        set: {
          autoReloadEnabled: input.enabled,
          autoReloadThresholdCents: input.thresholdCents ?? null,
          autoReloadAmountCents: input.amountCents ?? null,
        },
      });
  }
}
