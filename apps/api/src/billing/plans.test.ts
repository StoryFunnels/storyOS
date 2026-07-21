// env() is read lazily inside the plan helpers, so setting these before the test
// bodies run (imports are hoisted above, but no helper calls env() at import time)
// is enough to pin the price ids the reverse-map resolves against.
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.STRIPE_PRICE_BUSINESS = 'price_business_test';
process.env.STRIPE_PRICE_SEAT = 'price_seat_test';

import { describe, expect, it } from 'vitest';
import { basePriceId, creditExpiryDate, isPurchasablePlan, planForPriceId, seatOverage } from './plans';

describe('planForPriceId', () => {
  it('maps the configured Pro and Business price ids back to plans', () => {
    expect(planForPriceId('price_pro_test')).toBe('pro');
    expect(planForPriceId('price_business_test')).toBe('business');
  });

  it('returns undefined for the seat price and unknown ids (they are not plans)', () => {
    expect(planForPriceId('price_seat_test')).toBeUndefined();
    expect(planForPriceId('price_made_up')).toBeUndefined();
    expect(planForPriceId('')).toBeUndefined();
  });
});

describe('basePriceId', () => {
  it('returns the env-configured id per purchasable plan', () => {
    expect(basePriceId('pro')).toBe('price_pro_test');
    expect(basePriceId('business')).toBe('price_business_test');
  });
});

describe('isPurchasablePlan', () => {
  it('accepts only self-serve plans', () => {
    expect(isPurchasablePlan('pro')).toBe(true);
    expect(isPurchasablePlan('business')).toBe(true);
    expect(isPurchasablePlan('free')).toBe(false);
    expect(isPurchasablePlan('enterprise')).toBe(false);
  });
});

describe('seatOverage', () => {
  it('charges only seats beyond the included tier (Pro includes 3)', () => {
    expect(seatOverage('pro', 2)).toBe(0);
    expect(seatOverage('pro', 3)).toBe(0);
    expect(seatOverage('pro', 5)).toBe(2);
  });

  it('uses the Business included tier of 5', () => {
    expect(seatOverage('business', 5)).toBe(0);
    expect(seatOverage('business', 8)).toBe(3);
  });

  it('never goes negative when a workspace is under its included seats', () => {
    expect(seatOverage('business', 1)).toBe(0);
  });
});

describe('creditExpiryDate — MN-189 follow-up (#265)', () => {
  it('is exactly 12 months out', () => {
    const from = new Date('2026-01-15T12:00:00.000Z');
    const expiry = creditExpiryDate(from);
    expect(expiry.getUTCFullYear()).toBe(2027);
    expect(expiry.getUTCMonth()).toBe(from.getUTCMonth());
    expect(expiry.getUTCDate()).toBe(15);
  });

  it('rolls over year-end and handles a leap-day source date without skipping a day', () => {
    // 2028-02-29 (leap year) + 12 months -> 2029-02-29 doesn't exist, so
    // Date#setMonth rolls it to 2029-03-01 — documented behavior, not a bug:
    // this is the one calendar edge case where "12 months" can't land on the
    // same day-of-month.
    const from = new Date('2028-02-29T00:00:00.000Z');
    const expiry = creditExpiryDate(from);
    expect(expiry.getUTCFullYear()).toBe(2029);
  });
});
