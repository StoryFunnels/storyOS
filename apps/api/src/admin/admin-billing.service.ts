import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { billingSubscriptions, entitlementOverrideEvents, workspaces } from '../db/schema';
import { EntitlementsService } from '../billing/entitlements.service';
import type { BillingPlanId } from '@storyos/schemas';
import type { AdminEntitlementOverrideEvent, AdminWorkspaceBillingView } from '@storyos/schemas';

/**
 * #304 — the admin-only plan/entitlement-override write surface
 * admin.controller.ts's own doc comment deferred ("billing ops
 * (comp/refund/plan-change) ... each is its own careful, safety-reviewed
 * piece"). This is that piece, scoped to exactly three things:
 *
 * 1. setPlan — upserts billing_subscriptions directly. This is the ONLY
 *    place besides BillingService.reconcileSubscription (real Stripe
 *    webhooks) that writes that table, and unlike reconcileSubscription it
 *    never talks to Stripe at all.
 * 2. Entitlement overrides — no methods of its own; the controller calls
 *    EntitlementsService.setOverride/clearOverride directly. Duplicating a
 *    wrapper here would just be a second seam to keep in sync with the one
 *    EntitlementsService already owns.
 * 3. getBillingView — a read-only join of plan + active override + the full
 *    entitlement_override_events audit trail, so a plan change made through
 *    #1 or #2 is always inspectable afterwards.
 */
@Injectable()
export class AdminBillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Upsert the workspace's plan, bypassing Stripe entirely.
   *
   * stripeSubscriptionId/status are ALWAYS written as null here — even when a
   * Stripe-backed row already exists for this workspace. This is a deliberate
   * choice, not an oversight:
   *
   * - BillingService.syncSeatQuantity fires on every membership change and,
   *   whenever a row has a non-null stripeSubscriptionId and a non-'free'
   *   plan, calls the real Stripe API to push a seat-quantity update onto
   *   that subscription. If we preserved a stale stripeSubscriptionId while
   *   changing `plan` out from under it here, the next seat change would
   *   silently mutate a real Stripe subscription based on an admin-assigned
   *   plan it no longer matches — exactly the "no live Stripe" guarantee
   *   this endpoint exists to keep.
   * - BillingService.getStatus's own trial-elapsed check only special-cases
   *   a row with `stripeSubscriptionId: null`; leaving a stale id in place
   *   risks that lazy-downgrade logic disagreeing with a plan we just set
   *   administratively.
   * - Clearing it costs nothing for the comp/Enterprise-grant/grandfathering
   *   cases this endpoint is for: none of them have a live Stripe
   *   subscription to preserve a link to in the first place.
   *
   * Known limitation, intentionally out of scope (ticket's own non-goal):
   * if a workspace DOES still have a genuinely live, real Stripe subscription
   * running in parallel (e.g. comping a currently-paying customer without
   * first canceling their Stripe subscription), the next Stripe webhook for
   * that customer (renewal, update, cancellation) will fully re-project onto
   * this row via BillingService.reconcileSubscription's own
   * billing_customers → workspace lookup — which does NOT consult what we
   * write here — and will overwrite the admin-assigned plan back to whatever
   * Stripe says. This endpoint only ever touches StoryOS's own tables, so
   * making that guarantee airtight would mean also canceling the real Stripe
   * subscription, which is exactly the "no live Stripe" boundary the ticket
   * draws. Operationally: cancel/downgrade the real Stripe subscription
   * first (via the Portal/dashboard) if the intent is to fully replace it
   * with a comp plan; otherwise this is safe as-is for any workspace with no
   * live paying subscription to race against.
   */
  async setPlan(
    workspaceId: string,
    actorUserId: string,
    plan: BillingPlanId,
    reason: string,
    expiresAt: Date | null,
  ): Promise<void> {
    const workspace = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');

    const previousPlan = (
      await this.db.query.billingSubscriptions.findFirst({
        where: eq(billingSubscriptions.workspaceId, workspaceId),
      })
    )?.plan ?? 'free';

    const values = {
      workspaceId,
      plan,
      status: null,
      stripeSubscriptionId: null,
      // A plan set through this path isn't seat-metered by a real
      // subscription; leave seats at 0 rather than guessing — it only ever
      // fed Stripe's seat-overage line, which this row now has none of.
      seats: 0,
      cancelAtPeriodEnd: false,
      // Record-keeping only (matches workspace_entitlement_overrides'
      // featureFlags precedent of "recorded, not yet enforced"): there is no
      // sweep that auto-reverts a plan once this passes, unlike
      // workspaceEntitlementOverrides.expiresAt's lazy check-on-read in
      // EntitlementsService.getOverride. A human must call this endpoint
      // again to revert once a comp expires.
      currentPeriodEnd: expiresAt,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(billingSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: billingSubscriptions.workspaceId,
          set: { ...values, updatedAt: new Date() },
        });

      // Reuse the SAME audit trail entitlement overrides already write
      // (MN-196) rather than a second, parallel mechanism — the ticket's own
      // AC #4. `action: 'set'` is reused rather than adding a third enum
      // value (entitlement_override_event_action is a Postgres enum — adding
      // a value is its own migration hazard, not worth it for a field that's
      // otherwise a free-form jsonb snapshot); the snapshot payload itself
      // distinguishes a plan change from an entitlement-override change.
      await tx.insert(entitlementOverrideEvents).values({
        workspaceId,
        actorUserId,
        action: 'set',
        snapshot: { kind: 'plan_change', previousPlan, plan, expiresAt: expiresAt?.toISOString() ?? null },
        reason,
        expiresAt,
      });
    });
  }

  /** Read-only: current plan, active override, and the full audit trail for a workspace. */
  async getBillingView(workspaceId: string): Promise<AdminWorkspaceBillingView> {
    const workspace = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');

    const [subscription, override, events] = await Promise.all([
      this.db.query.billingSubscriptions.findFirst({
        where: eq(billingSubscriptions.workspaceId, workspaceId),
      }),
      this.entitlements.getOverride(workspaceId),
      this.db.query.entitlementOverrideEvents.findMany({
        where: eq(entitlementOverrideEvents.workspaceId, workspaceId),
        orderBy: [desc(entitlementOverrideEvents.createdAt)],
      }),
    ]);

    const view: AdminWorkspaceBillingView = {
      workspaceId,
      plan: (subscription?.plan ?? 'free') as BillingPlanId,
      status: subscription?.status ?? null,
      stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
      seats: subscription?.seats ?? 0,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      override: override
        ? {
            includedSeats: override.includedSeats,
            automationRunsPerMonth: override.automationRunsPerMonth,
            maxWorkspaces: override.maxWorkspaces,
            featureFlags: (override.featureFlags as Record<string, boolean> | null) ?? null,
            reason: override.reason,
            expiresAt: override.expiresAt?.toISOString() ?? null,
            createdBy: override.createdBy,
            updatedAt: override.updatedAt.toISOString(),
          }
        : null,
      auditTrail: events.map(
        (e): AdminEntitlementOverrideEvent => ({
          id: e.id,
          actorUserId: e.actorUserId,
          action: e.action,
          snapshot: e.snapshot,
          reason: e.reason,
          expiresAt: e.expiresAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        }),
      ),
    };
    return view;
  }
}
