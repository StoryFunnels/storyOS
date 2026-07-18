import { env } from '../config/env';

/**
 * The plan catalogue as code (MN-165 AC: "plans exist as config, not
 * hand-clicked"). This is the ONE place the finalized MN-107 pricing lives in
 * the backend; the Stripe seed script (seed-stripe.ts) creates Products/Prices
 * straight from it, and reconcile maps a Stripe price id back to a plan through
 * the env ids resolved here. Change a number here → re-seed → envs stay in sync.
 *
 * Money is in whole USD; Stripe wants cents, so the seed multiplies by 100.
 */
export type PlanId = 'free' | 'pro' | 'business' | 'enterprise';

export interface PlanDef {
  id: PlanId;
  name: string;
  /** Monthly base price in USD (per workspace). Enterprise is out-of-band. */
  priceUsd: number;
  /** Seats included before the $12 overage line kicks in. */
  includedSeats: number;
  /** Non-AI automation runs per month (n8n-style). Enforcement is MN-168. */
  automationRuns: number;
  /** Stripe lookup_key for the base price — stable across test/live re-seeds. */
  lookupKey?: string;
}

/** $12/member/mo, applied beyond includedSeats on Pro and Business alike. */
export const SEAT_PRICE_USD = 12;
export const SEAT_LOOKUP_KEY = 'storyos_seat_v1';

/**
 * MN-189 — StoryOS AI prepaid credits. Markup is token cost × 10 (owner
 * decision 2026-07-18, revised from an initial ×5 — a provisional
 * placeholder, to be revisited once real consumption data exists; see
 * MN-167/#58). $10 minimum top-up matches Linear's own model this is built
 * on. The default per-workspace monthly spend cap protects both sides from a
 * runaway agent, independent of the balance itself running out.
 */
export const AI_CREDIT_MARKUP_MULTIPLIER = 10;
export const AI_CREDIT_MIN_TOPUP_USD = 10;

export const PLANS: Record<PlanId, PlanDef> = {
  free: { id: 'free', name: 'Free', priceUsd: 0, includedSeats: 2, automationRuns: 100 },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 29,
    includedSeats: 3,
    automationRuns: 1_000,
    lookupKey: 'storyos_pro_v1',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceUsd: 99,
    includedSeats: 5,
    automationRuns: 10_000,
    lookupKey: 'storyos_business_v1',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: 0,
    /**
     * MN-196 — was 0 (unshipped placeholder): a workspace flipped to
     * 'enterprise' with no override set would have had zero included seats,
     * actively broken rather than merely unconfigured. Enterprise is
     * "requirement-driven, not numbers" (MN-107) — unlimited is the only
     * safe default until a real negotiated number is set via
     * workspace_entitlement_overrides.
     */
    includedSeats: Number.POSITIVE_INFINITY,
    automationRuns: Number.POSITIVE_INFINITY,
  },
};

/** Plans a workspace can self-serve into via checkout (Enterprise is sales-led). */
export const PURCHASABLE_PLANS = ['pro', 'business'] as const;
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

export function isPurchasablePlan(value: string): value is PurchasablePlan {
  return (PURCHASABLE_PLANS as readonly string[]).includes(value);
}

/** The configured Stripe base price id for a purchasable plan, or undefined. */
export function basePriceId(plan: PurchasablePlan): string | undefined {
  return plan === 'pro' ? env().STRIPE_PRICE_PRO : env().STRIPE_PRICE_BUSINESS;
}

/**
 * Reverse the mapping a webhook needs: a Stripe base price id → our plan id.
 * Built fresh (not memoised) so a test can vary env between cases. Only base
 * prices resolve here; the seat price is a line item, not a plan.
 */
export function planForPriceId(priceId: string): PlanId | undefined {
  const e = env();
  if (priceId && priceId === e.STRIPE_PRICE_PRO) return 'pro';
  if (priceId && priceId === e.STRIPE_PRICE_BUSINESS) return 'business';
  return undefined;
}

/**
 * Billable seats that exceed the plan's included tier — the quantity for the
 * $12 overage line. Never negative. Viewers/guests are already excluded upstream
 * because `billableCount` comes from AccessService.billableUserIds (MN-190).
 */
export function seatOverage(plan: PlanId, billableCount: number): number {
  return Math.max(0, billableCount - PLANS[plan].includedSeats);
}
