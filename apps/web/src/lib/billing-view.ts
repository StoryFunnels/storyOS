/**
 * Ticket #1186 — what Settings › Plan & billing offers and says, per plan and per deployment, as pure functions so the stale-copy
 * fixes from Dara's #974 inventory (finding 5) are tested and not remembered.
 *
 * Three things were wrong:
 *  - Enterprise saw BOTH "Upgrade to Pro" and "Upgrade to Business". The old gate was `plan !== 'pro' && plan !== 'business'` for Pro and
 *    `plan !== 'business'` for Business: written for three plans, it let the fourth through. An upgrade is offered only to a plan BELOW
 *    the target, from the plan ladder below, so a plan added later cannot be offered an upgrade by accident.
 *  - The "Your own AI" card said "Connect one under API tokens". Connecting an AI is the Connect your AI page; API tokens are for scripts.
 *  - Self-hosting wording belongs to the self-managed state only. On cloud (`enabled`, the billing endpoint's own answer, the same
 *    signal the Settings nav reads to show or hide this page) no sentence on the page speaks of self-hosting.
 */
export type BillingPlan = 'free' | 'pro' | 'business' | 'enterprise';
export type PurchasablePlan = 'pro' | 'business';

/** Low to high. Enterprise is above both purchasable plans: it is sold by hand and has nothing to upgrade to. */
const PLAN_LADDER: ReadonlyArray<BillingPlan> = ['free', 'pro', 'business', 'enterprise'];
const PURCHASABLE: ReadonlyArray<PurchasablePlan> = ['pro', 'business'];

/** The plans a workspace on `plan` can buy: only those above it. Free: Pro and Business. Pro: Business. Business and Enterprise: none. */
export function upgradeTargets(plan: BillingPlan): PurchasablePlan[] {
  const at = PLAN_LADDER.indexOf(plan);
  // An unknown plan offers nothing: never sell on a guess about what the person already has.
  if (at < 0) return [];
  return PURCHASABLE.filter((p) => PLAN_LADDER.indexOf(p) > at);
}

/** The one-time Pro trial is for a Free workspace that has never started one. */
export function canStartTrial(plan: BillingPlan, trialEndsAt: string | null): boolean {
  return plan === 'free' && !trialEndsAt;
}

export const UPGRADE_LABEL: Record<PurchasablePlan, string> = { pro: 'Upgrade to Pro', business: 'Upgrade to Business' };

/** Shown instead of the page body when this deployment has no billing at all (no Stripe key: a self-managed StoryOS). */
export const BILLING_UNAVAILABLE = 'Billing is a cloud feature and isn’t available on this self-hosted instance.';

export const OWN_AI_COPY = {
  title: 'Your own AI',
  description: 'Connect your own Claude or ChatGPT over MCP.',
  headline: 'Unlimited, and never metered',
  body: 'Runs driven by your own AI provider never count against any allowance on any plan and are never billed by StoryOS.',
  /** The sentence that follows the body, ending in the link's label. */
  setUpPrefix: 'Set one up under',
  linkLabel: 'Connect your AI',
} as const;

/** The cloud page's fixed sentences. The page renders THESE constants (it holds no copy of its own), so the test reads what is drawn. */
export const BILLING_COPY = {
  lead: 'Plan, seats and invoices',
  trial: 'No card required. If it ends without upgrading, this workspace moves to Free — nothing is locked or deleted, and every feature stays reachable.',
  usageDescription: 'StoryOS never limits items — this is scale, not capability.',
  seatsBefore: 'Admins, members, and guests with edit access or higher. Viewer and commenter guests, and pending invites, don’t count — see',
  seatsLink: 'Members',
  seatsAfter: 'for everyone with access.',
} as const;

export interface BillingCopyLine {
  where: string;
  text: string;
}

/**
 * Every fixed sentence the cloud render of the page can show, so a test can assert that none of them speaks of self-hosting and none
 * points a person at the wrong page. Dynamic text (the plan name, dates, counts) is not in it.
 */
export function cloudBillingSentences(): BillingCopyLine[] {
  return [
    { where: 'lead', text: BILLING_COPY.lead },
    { where: 'trial', text: BILLING_COPY.trial },
    { where: 'usage', text: BILLING_COPY.usageDescription },
    { where: 'seats', text: `${BILLING_COPY.seatsBefore} ${BILLING_COPY.seatsLink} ${BILLING_COPY.seatsAfter}` },
    { where: 'own AI', text: `${OWN_AI_COPY.description} ${OWN_AI_COPY.headline}. ${OWN_AI_COPY.body} ${OWN_AI_COPY.setUpPrefix} ${OWN_AI_COPY.linkLabel}.` },
    ...(['free', 'pro', 'business', 'enterprise'] as const).flatMap((p) => upgradeTargets(p).map((t) => ({ where: `button on ${p}`, text: UPGRADE_LABEL[t] }))),
  ];
}
