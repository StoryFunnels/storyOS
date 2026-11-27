/**
 * Ticket #1391 — the ONE rule for "this workspace is paying us right now", used by both Est. MRR (admin-overview.service) and the
 * Revenue column of Cost & margin (cost-attribution.service). They share this function so the two numbers cannot disagree.
 *
 * Paying = a live-mode Stripe subscription that is billing (`active`, or `past_due`: still owed). Not a sandbox subscription, not a
 * trial (nothing paid yet), not a plan an admin granted by hand (it has no Stripe subscription at all).
 */
export interface BillingRowFacts {
  livemode: boolean | null;
  stripeSubscriptionId: string | null;
  status: string | null;
}

const BILLING_STATUSES = new Set(['active', 'past_due']);

export function isLiveBilling(row: BillingRowFacts | null | undefined): boolean {
  if (!row) return false;
  return row.livemode === true && row.stripeSubscriptionId !== null && row.status !== null && BILLING_STATUSES.has(row.status);
}
