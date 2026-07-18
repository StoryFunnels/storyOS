/**
 * MN-165 — seed Stripe Products/Prices from the plan catalogue (plans.ts) so the
 * lineup is config, not hand-clicked, and identical across every environment.
 *
 * Idempotent: products are matched by a `storyos_key` metadata tag and prices by
 * `lookup_key`, so re-running never duplicates. Run against a TEST key:
 *
 *     STRIPE_SECRET_KEY=sk_test_... pnpm --filter @storyos/api billing:seed
 *
 * It prints the STRIPE_PRICE_* lines to paste into your .env.
 */
import Stripe from 'stripe';
import { env } from '../config/env';
import { PLANS, SEAT_LOOKUP_KEY, SEAT_PRICE_USD, type PlanDef } from './plans';

async function ensureProduct(stripe: Stripe, key: string, name: string): Promise<string> {
  const found = await stripe.products.search({ query: `metadata['storyos_key']:'${key}'` });
  if (found.data[0]) return found.data[0].id;
  const product = await stripe.products.create({ name, metadata: { storyos_key: key } });
  return product.id;
}

/** Create the monthly recurring price under lookupKey, or reuse the existing one. */
async function ensurePrice(
  stripe: Stripe,
  productId: string,
  lookupKey: string,
  unitAmountCents: number,
): Promise<string> {
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data[0]) return existing.data[0].id;
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: unitAmountCents,
    recurring: { interval: 'month' },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
  });
  return price.id;
}

async function seedPlan(stripe: Stripe, plan: PlanDef): Promise<string> {
  if (!plan.lookupKey) throw new Error(`Plan ${plan.id} has no lookupKey and cannot be seeded.`);
  const productId = await ensureProduct(stripe, plan.id, `StoryOS ${plan.name}`);
  return ensurePrice(stripe, productId, plan.lookupKey, plan.priceUsd * 100);
}

async function main(): Promise<void> {
  const key = env().STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is required to seed Stripe.');
  if (key.startsWith('sk_live_')) throw new Error('Refusing to seed against a LIVE key. Use sk_test_.');
  const stripe = new Stripe(key);

  const pro = await seedPlan(stripe, PLANS.pro);
  const business = await seedPlan(stripe, PLANS.business);
  const seatProduct = await ensureProduct(stripe, 'seat', 'StoryOS Seat');
  const seat = await ensurePrice(stripe, seatProduct, SEAT_LOOKUP_KEY, SEAT_PRICE_USD * 100);

  console.log(
    [
      '',
      'Stripe seed complete. Paste these into your .env:',
      '',
      `STRIPE_PRICE_PRO=${pro}`,
      `STRIPE_PRICE_BUSINESS=${business}`,
      `STRIPE_PRICE_SEAT=${seat}`,
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Stripe seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
