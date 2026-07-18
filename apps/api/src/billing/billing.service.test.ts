process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.STRIPE_PRICE_BUSINESS = 'price_business_test';
process.env.STRIPE_PRICE_SEAT = 'price_seat_test';

import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
import type { AiCreditsService } from './ai-credits.service';
import { BillingService } from './billing.service';
import type { StripeService } from './stripe.service';

/**
 * A fake Db that captures billing_subscriptions upserts and lets a test dictate
 * what the billing_events idempotency claim returns (`[]` = duplicate). Only the
 * exact call chains BillingService uses are implemented.
 */
function makeDb(opts: {
  customerRow?: { workspaceId: string };
  eventClaim?: Array<{ id: string }>;
  subscriptionRow?: Record<string, unknown>;
}) {
  const upserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const eventClaim = opts.eventClaim ?? [{ id: 'evt_1' }];
  const db = {
    query: {
      billingCustomers: { findFirst: vi.fn().mockResolvedValue(opts.customerRow) },
      billingSubscriptions: { findFirst: vi.fn().mockResolvedValue(opts.subscriptionRow) },
      workspaces: { findFirst: vi.fn().mockResolvedValue({ id: 'ws1', name: 'W', slug: 'w' }) },
    },
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          return this;
        },
        onConflictDoNothing() {
          return { returning: async () => eventClaim };
        },
        onConflictDoUpdate() {
          upserts.push(vals);
          return Promise.resolve();
        },
      };
    },
    update: () => {
      let vals: Record<string, unknown> = {};
      return {
        set(v: Record<string, unknown>) {
          vals = v;
          return this;
        },
        where() {
          updates.push(vals);
          return Promise.resolve();
        },
      };
    },
  } as unknown as Db;
  return { db, upserts, updates };
}

const stripeStub = { client: {} } as unknown as StripeService;
const accessStub = { billableUserIds: vi.fn().mockResolvedValue([]) } as unknown as AccessService;
const aiCreditsStub = {} as unknown as AiCreditsService;

/** A minimal Stripe.Subscription with the fields reconcile actually reads. */
function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        { price: { id: 'price_pro_test' }, quantity: 1, current_period_end: 1893456000 },
        { price: { id: 'price_seat_test' }, quantity: 2 },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe('BillingService.reconcileSubscription', () => {
  it('projects plan from the base price and seats from the seat line', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.reconcileSubscription(subscription());

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      workspaceId: 'ws1',
      plan: 'pro',
      status: 'active',
      seats: 2,
      stripeSubscriptionId: 'sub_1',
    });
    expect(upserts[0]!.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it('downgrades a canceled subscription to Free without deleting the row', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.reconcileSubscription(subscription({ status: 'canceled' }));

    expect(upserts[0]).toMatchObject({ plan: 'free', status: 'canceled' });
  });

  it('MN-193: a failed payment (past_due) keeps the plan intact — dunning is a grace period, not a punishment', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    // Stripe marks a subscription past_due on the FIRST failed charge, well
    // before its own retry schedule exhausts — the workspace keeps its plan,
    // seats and allowances throughout. Only a terminal status (canceled /
    // incomplete_expired) ever downgrades — see the test above.
    await svc.reconcileSubscription(subscription({ status: 'past_due' }));

    expect(upserts[0]).toMatchObject({ plan: 'pro', status: 'past_due', seats: 2 });
  });

  it('MN-193: incomplete_expired downgrades to Free exactly like canceled — both are terminal', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.reconcileSubscription(subscription({ status: 'incomplete_expired' }));

    expect(upserts[0]).toMatchObject({ plan: 'free', status: 'incomplete_expired' });
  });

  it('skips a subscription for a customer that maps to no workspace', async () => {
    const { db, upserts } = makeDb({ customerRow: undefined });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.reconcileSubscription(subscription());

    expect(upserts).toHaveLength(0);
  });

  it('skips a live subscription whose price we do not recognise (no guessing)', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.reconcileSubscription(
      subscription({ items: { data: [{ price: { id: 'price_alien' }, quantity: 1 }] } } as Partial<Stripe.Subscription>),
    );

    expect(upserts).toHaveLength(0);
  });
});

describe('BillingService.applyEvent idempotency', () => {
  const event = {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    data: { object: subscription() },
  } as unknown as Stripe.Event;

  it('handles an event the first time it is seen', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' }, eventClaim: [{ id: 'evt_1' }] });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.applyEvent(event);

    expect(upserts).toHaveLength(1);
  });

  it('no-ops when the event id was already claimed (duplicate delivery)', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' }, eventClaim: [] });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    await svc.applyEvent(event);

    expect(upserts).toHaveLength(0);
  });
});

describe('BillingService.applyEvent — MN-189 checkout.session.completed routing', () => {
  function checkoutEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          metadata: { workspaceId: 'ws1', kind: 'ai_credit_topup' },
          payment_intent: 'pi_1',
          amount_total: 1000,
          ...overrides,
        },
      },
    } as unknown as Stripe.Event;
  }

  it('routes a one-time AI-credit top-up session to AiCreditsService.applyTopUp', async () => {
    const { db } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const applyTopUp = vi.fn().mockResolvedValue(undefined);
    const svc = new BillingService(db, stripeStub, accessStub, { applyTopUp } as unknown as typeof aiCreditsStub);

    await svc.applyEvent(checkoutEvent());

    expect(applyTopUp).toHaveBeenCalledWith('ws1', 1000, 'pi_1');
  });

  it('ignores a subscription-mode checkout — that plan state comes from customer.subscription.* instead', async () => {
    const { db } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const applyTopUp = vi.fn();
    const svc = new BillingService(db, stripeStub, accessStub, { applyTopUp } as unknown as typeof aiCreditsStub);

    await svc.applyEvent(checkoutEvent({ mode: 'subscription' }));

    expect(applyTopUp).not.toHaveBeenCalled();
  });

  it('ignores a payment-mode checkout without our ai_credit_topup metadata tag', async () => {
    const { db } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const applyTopUp = vi.fn();
    const svc = new BillingService(db, stripeStub, accessStub, { applyTopUp } as unknown as typeof aiCreditsStub);

    await svc.applyEvent(checkoutEvent({ metadata: { workspaceId: 'ws1' } }));

    expect(applyTopUp).not.toHaveBeenCalled();
  });
});

describe('BillingService.getStatus — MN-192 lazy trial-expiry sweep', () => {
  const past = new Date(Date.now() - 1000);
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24);

  it('downgrades our own no-card trial to Free the moment it is read past expiry', async () => {
    const { db, updates } = makeDb({
      subscriptionRow: {
        plan: 'pro',
        status: 'trialing',
        stripeSubscriptionId: null,
        seats: 0,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: past,
      },
    });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    const status = await svc.getStatus('ws1');

    expect(status.plan).toBe('free');
    expect(status.status).toBeNull();
    // The trial date itself is preserved — it's the one-trial-per-workspace signal.
    expect(status.trialEndsAt).toBe(past);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ plan: 'free', status: null });
  });

  it('leaves an active (not yet expired) trial alone', async () => {
    const { db, updates } = makeDb({
      subscriptionRow: {
        plan: 'pro',
        status: 'trialing',
        stripeSubscriptionId: null,
        seats: 0,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: future,
      },
    });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    const status = await svc.getStatus('ws1');

    expect(status.plan).toBe('pro');
    expect(status.status).toBe('trialing');
    expect(updates).toHaveLength(0);
  });

  it('never touches a REAL Stripe-backed trialing subscription — Stripe owns that transition', async () => {
    const { db, updates } = makeDb({
      subscriptionRow: {
        plan: 'pro',
        status: 'trialing',
        stripeSubscriptionId: 'sub_real', // a live Stripe subscription IS attached
        seats: 0,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: past, // even though Stripe's own trial_end has elapsed
      },
    });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    const status = await svc.getStatus('ws1');

    // Untouched: reconcileSubscription() via webhook is the only thing
    // allowed to change a Stripe-backed subscription's status.
    expect(status.plan).toBe('pro');
    expect(status.status).toBe('trialing');
    expect(updates).toHaveLength(0);
  });

  it('a non-trialing row is never swept, regardless of trialEndsAt', async () => {
    const { db, updates } = makeDb({
      subscriptionRow: {
        plan: 'business',
        status: 'active',
        stripeSubscriptionId: 'sub_real',
        seats: 0,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: past,
      },
    });
    const svc = new BillingService(db, stripeStub, accessStub, aiCreditsStub);

    const status = await svc.getStatus('ws1');

    expect(status.plan).toBe('business');
    expect(updates).toHaveLength(0);
  });
});
