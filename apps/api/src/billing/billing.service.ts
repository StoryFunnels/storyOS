import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  billingCustomers,
  billingEvents,
  billingSubscriptions,
  workspaces,
} from '../db/schema';
import { env } from '../config/env';
import { AccessService } from '../access/access.service';
import { AiCreditsService } from './ai-credits.service';
import { StripeService } from './stripe.service';
import {
  basePriceId,
  planForPriceId,
  seatOverage,
  type PlanId,
  type PurchasablePlan,
} from './plans';

/** The plan/entitlement snapshot MN-168 and the UI (MN-166) read. */
export interface BillingStatus {
  plan: PlanId;
  status: Stripe.Subscription.Status | null;
  seats: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
}

const FREE_STATUS: BillingStatus = {
  plan: 'free',
  status: null,
  seats: 0,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  trialEndsAt: null,
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stripe: StripeService,
    private readonly access: AccessService,
    private readonly aiCredits: AiCreditsService,
  ) {}

  private settingsUrl(query: string): string {
    return `${env().WEB_URL}/settings/billing?${query}`;
  }

  /** Current plan state, defaulting to Free for a workspace that never billed. */
  async getStatus(workspaceId: string): Promise<BillingStatus> {
    const row = await this.db.query.billingSubscriptions.findFirst({
      where: eq(billingSubscriptions.workspaceId, workspaceId),
    });
    if (!row) return FREE_STATUS;

    // MN-192: our own no-card trial (started by startTrial(), no real Stripe
    // subscription attached) is never touched by a webhook, so nothing else
    // ever notices it elapsed. Detect and downgrade it here, lazily, on the
    // very next read — no cron, no timing gap, no multi-replica coordination.
    // A REAL Stripe-backed trialing subscription is deliberately excluded:
    // Stripe owns that transition and will webhook reconcileSubscription()
    // when it ends, so overwriting it here would race that update.
    if (
      !row.stripeSubscriptionId &&
      row.status === 'trialing' &&
      row.trialEndsAt &&
      row.trialEndsAt.getTime() <= Date.now()
    ) {
      await this.db
        .update(billingSubscriptions)
        .set({ plan: 'free', status: null })
        .where(eq(billingSubscriptions.workspaceId, workspaceId));
      return {
        plan: 'free',
        status: null,
        seats: row.seats,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        currentPeriodEnd: row.currentPeriodEnd,
        // Kept, not cleared: startTrial()'s one-trial-per-workspace guard
        // reads this to know a trial already happened.
        trialEndsAt: row.trialEndsAt,
      };
    }

    return {
      plan: row.plan,
      status: row.status,
      seats: row.seats,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      currentPeriodEnd: row.currentPeriodEnd,
      trialEndsAt: row.trialEndsAt,
    };
  }

  /** Billable seats today (viewers/guests excluded — MN-190's predicate). */
  async billableSeatCount(workspaceId: string): Promise<number> {
    return (await this.access.billableUserIds(workspaceId)).length;
  }

  /**
   * MN-190 — push the current billable-seat overage onto the workspace's live
   * Stripe subscription as the $12/seat line's quantity. Called after any
   * membership change (invite accepted, role changed, member removed) so the
   * bill tracks reality without a human re-syncing it by hand.
   *
   * A no-op on Free (no subscription exists — Free's ceiling is enforced by
   * EntitlementsService.can('add_seat') at invite time, not billed) and on
   * self-host. `proration_behavior: 'create_prorations'` is Stripe's own
   * default for a quantity change, but it's named explicitly here rather than
   * relied on implicitly — a silent default change upstream would otherwise
   * change our billing behavior without a line in our own diff.
   */
  async syncSeatQuantity(workspaceId: string): Promise<void> {
    if (!this.stripe.enabled) return;
    const seatPriceId = env().STRIPE_PRICE_SEAT;
    if (!seatPriceId) return;

    const row = await this.db.query.billingSubscriptions.findFirst({
      where: eq(billingSubscriptions.workspaceId, workspaceId),
    });
    if (!row?.stripeSubscriptionId || row.plan === 'free') return;

    const overage = seatOverage(row.plan, await this.billableSeatCount(workspaceId));
    const subscription = await this.stripe.client.subscriptions.retrieve(row.stripeSubscriptionId);
    const seatItem = subscription.items.data.find((item) => item.price.id === seatPriceId);

    if (overage > 0) {
      if (seatItem) {
        if (seatItem.quantity !== overage) {
          await this.stripe.client.subscriptionItems.update(seatItem.id, {
            quantity: overage,
            proration_behavior: 'create_prorations',
          });
        }
      } else {
        await this.stripe.client.subscriptionItems.create({
          subscription: row.stripeSubscriptionId,
          price: seatPriceId,
          quantity: overage,
          proration_behavior: 'create_prorations',
        });
      }
    } else if (seatItem && (seatItem.quantity ?? 0) > 0) {
      // Dropping to 0 rather than deleting the item — Stripe still prorates a
      // credit for the unused portion, and the line reappears cleanly the
      // next time a seat goes over instead of needing to be recreated.
      await this.stripe.client.subscriptionItems.update(seatItem.id, {
        quantity: 0,
        proration_behavior: 'create_prorations',
      });
    }
  }

  /**
   * Find or create the workspace's Stripe customer and persist the mapping. The
   * mapping is the join between our world and Stripe's; it is written once and
   * reused, and carries the workspace id in metadata so a customer found in the
   * Stripe dashboard is traceable back here.
   */
  async ensureCustomer(workspaceId: string): Promise<string> {
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

    // onConflictDoNothing guards the race where two requests create a customer
    // at once: the loser's insert no-ops and we re-read the winner's id below.
    await this.db
      .insert(billingCustomers)
      .values({ workspaceId, stripeCustomerId: customer.id })
      .onConflictDoNothing();
    const row = await this.db.query.billingCustomers.findFirst({
      where: eq(billingCustomers.workspaceId, workspaceId),
    });
    return row?.stripeCustomerId ?? customer.id;
  }

  /**
   * A Checkout session for a purchasable plan. Line items are the base price
   * (qty 1) plus, when the workspace already exceeds the included tier, the $12
   * licensed seat line at the overage quantity. Stripe Tax is on; the session is
   * subscription-mode so it creates the subscription on completion (webhook then
   * reconciles our projection).
   */
  async createCheckoutSession(workspaceId: string, plan: PurchasablePlan): Promise<string> {
    const priceId = basePriceId(plan);
    if (!priceId) {
      throw new NotFoundException(
        `No Stripe price configured for '${plan}'. Run the billing:seed script and set the price env vars.`,
      );
    }
    const customer = await this.ensureCustomer(workspaceId);
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: priceId, quantity: 1 }];

    const seatPrice = env().STRIPE_PRICE_SEAT;
    const overage = seatOverage(plan, await this.billableSeatCount(workspaceId));
    if (seatPrice && overage > 0) lineItems.push({ price: seatPrice, quantity: overage });

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer,
      line_items: lineItems,
      success_url: this.settingsUrl('status=success'),
      cancel_url: this.settingsUrl('status=canceled'),
      subscription_data: { metadata: { workspaceId } },
      metadata: { workspaceId, plan },
    };
    // Tax is opt-in (MN-165). customer_update.address is only needed so Stripe can
    // locate the customer for tax, so it rides along only when tax is on.
    if (env().STRIPE_TAX_ENABLED) {
      params.automatic_tax = { enabled: true };
      params.customer_update = { address: 'auto' };
    }

    const session = await this.stripe.client.checkout.sessions.create(params);
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
    return session.url;
  }

  /** A Customer Portal session so the workspace can manage card/plan/invoices. */
  async createPortalSession(workspaceId: string): Promise<string> {
    const customer = await this.ensureCustomer(workspaceId);
    const session = await this.stripe.client.billingPortal.sessions.create({
      customer,
      return_url: this.settingsUrl('status=portal_return'),
    });
    return session.url;
  }

  /**
   * Start the 30-day Pro trial (MN-107): unlimited Pro, NO card, NO Stripe
   * subscription yet. We record it locally; MN-192 owns the expiry sweep that
   * downgrades to Free. Idempotent — re-calling while a trial/subscription
   * already exists is a no-op that returns the current status.
   */
  async startTrial(workspaceId: string): Promise<BillingStatus> {
    const current = await this.getStatus(workspaceId);
    if (current.plan !== 'free' || current.trialEndsAt) return current;

    const trialEndsAt = new Date(Date.now() + env().BILLING_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    await this.db
      .insert(billingSubscriptions)
      .values({ workspaceId, plan: 'pro', status: 'trialing', trialEndsAt })
      .onConflictDoUpdate({
        target: billingSubscriptions.workspaceId,
        set: { plan: 'pro', status: 'trialing', trialEndsAt },
      });
    return this.getStatus(workspaceId);
  }

  /**
   * Project a Stripe subscription onto our row. This is the single write path
   * for plan state driven by Stripe — both webhooks and any manual sync funnel
   * through here so the mapping logic lives in exactly one place.
   *
   * Unknown base price (e.g. a subscription created by hand in the dashboard for
   * a price we don't recognise) is logged and skipped rather than guessed.
   */
  async reconcileSubscription(sub: Stripe.Subscription): Promise<void> {
    const workspaceId = await this.workspaceForCustomer(sub.customer);
    if (!workspaceId) {
      this.logger.warn(`No workspace mapped to Stripe customer ${String(sub.customer)}; skipping.`);
      return;
    }

    const seatPrice = env().STRIPE_PRICE_SEAT;
    let plan: PlanId | undefined;
    let seats = 0;
    for (const item of sub.items.data) {
      const mapped = planForPriceId(item.price.id);
      if (mapped) plan = mapped;
      if (seatPrice && item.price.id === seatPrice) seats = item.quantity ?? 0;
    }

    // A canceled/expired subscription means the workspace falls back to Free —
    // a downgrade, never a deletion (MN-193). We keep the row for history.
    const terminal = sub.status === 'canceled' || sub.status === 'incomplete_expired';
    if (!plan && !terminal) {
      this.logger.warn(`Subscription ${sub.id} has no recognised StoryOS price; skipping.`);
      return;
    }
    const effectivePlan: PlanId = terminal ? 'free' : (plan ?? 'free');

    const periodEnd = sub.items.data[0]?.current_period_end ?? null;
    const values = {
      workspaceId,
      plan: effectivePlan,
      status: sub.status,
      stripeSubscriptionId: sub.id,
      seats,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    };
    await this.db
      .insert(billingSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: billingSubscriptions.workspaceId, set: values });
  }

  private async workspaceForCustomer(
    customer: string | Stripe.Customer | Stripe.DeletedCustomer,
  ): Promise<string | undefined> {
    const customerId = typeof customer === 'string' ? customer : customer.id;
    const row = await this.db.query.billingCustomers.findFirst({
      where: eq(billingCustomers.stripeCustomerId, customerId),
    });
    return row?.workspaceId;
  }

  /**
   * Apply a verified webhook event exactly once. The event id is claimed in
   * billing_events with onConflictDoNothing; if the claim inserts nothing, this
   * event has already been handled and we no-op. Only after claiming do we act.
   */
  async applyEvent(event: Stripe.Event): Promise<void> {
    const claimed = await this.db
      .insert(billingEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (claimed.length === 0) {
      this.logger.debug(`Duplicate webhook ${event.id} (${event.type}) — ignored.`);
      return;
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.reconcileSubscription(event.data.object);
        break;
      case 'invoice.payment_failed':
      case 'invoice.paid': {
        // Reflect the payment outcome by re-reading the subscription it belongs
        // to. Dunning/downgrade policy proper lives in MN-193; here we just keep
        // status truthful (e.g. past_due) so the app can react.
        const invoice = event.data.object;
        const subId = this.subscriptionIdFromInvoice(invoice);
        if (subId) await this.reconcileSubscription(await this.stripe.client.subscriptions.retrieve(subId));
        break;
      }
      case 'customer.subscription.trial_will_end':
        // MN-192 sends the heads-up email; nothing to project here.
        this.logger.log(`Trial ending soon for subscription ${event.data.object.id}.`);
        break;
      case 'checkout.session.completed': {
        // MN-189: a ONE-TIME payment credits the AI balance; a subscription
        // checkout ALSO fires this event, but that plan state is already
        // driven by customer.subscription.* — only mode 'payment' with our
        // own metadata tag is ours to act on here.
        const session = event.data.object;
        const workspaceId = session.metadata?.['workspaceId'];
        const paymentIntentId =
          typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (session.mode === 'payment' && session.metadata?.['kind'] === 'ai_credit_topup' && workspaceId && paymentIntentId) {
          await this.aiCredits.applyTopUp(workspaceId, session.amount_total ?? 0, paymentIntentId);
        }
        break;
      }
      default:
        this.logger.debug(`Unhandled webhook type ${event.type}.`);
    }
  }

  private subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | undefined {
    const parent = invoice.parent?.subscription_details?.subscription;
    if (parent) return typeof parent === 'string' ? parent : parent.id;
    return undefined;
  }
}
