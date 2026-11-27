import { describe, expect, it } from 'vitest';
import { isLiveBilling } from './live-billing';

const live = { livemode: true, stripeSubscriptionId: 'sub_1', status: 'active' };

describe('isLiveBilling (#1391)', () => {
  it('a live-mode Stripe subscription that is active or past_due is paying', () => {
    expect(isLiveBilling(live)).toBe(true);
    expect(isLiveBilling({ ...live, status: 'past_due' })).toBe(true);
  });

  it('every other way of being on a paid plan is not', () => {
    expect(isLiveBilling({ ...live, livemode: false }), 'sandbox').toBe(false);
    expect(isLiveBilling({ ...live, livemode: null }), 'mode never recorded').toBe(false);
    expect(isLiveBilling({ ...live, status: 'trialing' }), 'trial').toBe(false);
    expect(isLiveBilling({ ...live, status: 'canceled' }), 'canceled').toBe(false);
    expect(isLiveBilling({ ...live, status: null }), 'no status').toBe(false);
    expect(isLiveBilling({ ...live, stripeSubscriptionId: null }), 'no Stripe subscription (hand-granted)').toBe(false);
    expect(isLiveBilling(null), 'no row at all').toBe(false);
  });
});
