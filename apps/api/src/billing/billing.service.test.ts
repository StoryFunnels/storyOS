process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.STRIPE_PRICE_BUSINESS = 'price_business_test';
process.env.STRIPE_PRICE_SEAT = 'price_seat_test';

import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
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
}) {
  const upserts: Record<string, unknown>[] = [];
  const eventClaim = opts.eventClaim ?? [{ id: 'evt_1' }];
  const db = {
    query: {
      billingCustomers: { findFirst: vi.fn().mockResolvedValue(opts.customerRow) },
      billingSubscriptions: { findFirst: vi.fn().mockResolvedValue(undefined) },
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
  } as unknown as Db;
  return { db, upserts };
}

const stripeStub = { client: {} } as unknown as StripeService;
const accessStub = { billableUserIds: vi.fn().mockResolvedValue([]) } as unknown as AccessService;

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
    const svc = new BillingService(db, stripeStub, accessStub);

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
    const svc = new BillingService(db, stripeStub, accessStub);

    await svc.reconcileSubscription(subscription({ status: 'canceled' }));

    expect(upserts[0]).toMatchObject({ plan: 'free', status: 'canceled' });
  });

  it('skips a subscription for a customer that maps to no workspace', async () => {
    const { db, upserts } = makeDb({ customerRow: undefined });
    const svc = new BillingService(db, stripeStub, accessStub);

    await svc.reconcileSubscription(subscription());

    expect(upserts).toHaveLength(0);
  });

  it('skips a live subscription whose price we do not recognise (no guessing)', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' } });
    const svc = new BillingService(db, stripeStub, accessStub);

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
    const svc = new BillingService(db, stripeStub, accessStub);

    await svc.applyEvent(event);

    expect(upserts).toHaveLength(1);
  });

  it('no-ops when the event id was already claimed (duplicate delivery)', async () => {
    const { db, upserts } = makeDb({ customerRow: { workspaceId: 'ws1' }, eventClaim: [] });
    const svc = new BillingService(db, stripeStub, accessStub);

    await svc.applyEvent(event);

    expect(upserts).toHaveLength(0);
  });
});
