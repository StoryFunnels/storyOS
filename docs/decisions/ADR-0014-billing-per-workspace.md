# ADR-0014: Billing — one Stripe customer and subscription per workspace

- **Status:** accepted
- **Date:** 2026-07-18
- **Implements:** MN-165 (Stripe integration), against the finalized pricing in MN-107
- **Feeds:** MN-168 (entitlements), MN-190 (seats), MN-191 (workspace-scoped subs), MN-192 (trial), MN-193 (dunning)

## Context

MN-107 prices Business **per workspace** at $99, and lets one account own several workspaces. Stripe therefore has to model a workspace, not a user or an org, as the unit that carries a plan. The ticket named two candidate shapes:

1. **Subscription per workspace** — each workspace is its own Stripe customer + subscription.
2. **One subscription, quantity = workspace count** — a single customer, one line whose quantity is the number of Business workspaces.

Option 2 makes seat math ambiguous the moment two workspaces have different member counts (the $12 overage is per-workspace, but a single quantity-based line can't express "workspace A is +2 seats, workspace B is +0"). It also couples every workspace's lifecycle to one invoice.

## Decision

**One Stripe customer and one subscription per workspace (1:1:1).** The local projection (`billing_customers`, `billing_subscriptions`) is keyed by `workspace_id`, never by customer. A subscription carries two line items: the base plan price (qty 1) and the $12 licensed seat price at the overage quantity. Seat quantity is driven by `AccessService.billableUserIds` — viewers and commenter-only guests never count (MN-190).

- **Free** — no subscription; the absence of a row *is* Free.
- **Trial** — 30-day Pro tracked locally with no card and no Stripe subscription (MN-192 owns expiry). A trial creates a `billing_subscriptions` row with `plan=pro, status=trialing`, not a Stripe object.
- **Pro / Business** — a real Stripe subscription created via Checkout; webhooks reconcile the projection.
- **Enterprise** — out of band (custom), not self-serve.

Stripe is the source of truth; our tables are a read cache kept current by **verified, idempotent** webhooks (`billing_events` claims each event id exactly once). Nothing local is authoritative over Stripe.

## Consequences

- A multi-workspace Business account has **multiple customers and multiple cards/invoices** — one per workspace. This is the accepted cost of unambiguous per-workspace seat math and independent lifecycles.
- Per-workspace billing, proration, cancellation and dunning are all trivial because they map to exactly one Stripe subscription.
- **Dunning never deletes.** Failed payment escalates to a downgrade to Free at most; data and export stay available throughout (MN-193).
- If consolidated invoicing per account is later wanted, MN-191 can move to *one customer, many subscriptions* — the projection already tolerates it because the key is the workspace, not the customer, so no table change is forced.

## Alternatives considered

- **Quantity = workspace count** (option 2): rejected — can't express per-workspace seat overage, and one invoice for many workspaces couples unrelated lifecycles.
- **User/org-level subscription** (better-auth Stripe plugin): rejected — the billing unit in MN-107 is the workspace, and there is no org entity above workspace today.
