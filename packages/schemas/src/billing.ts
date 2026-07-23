import { z } from 'zod';

/**
 * #304 — admin plan-override + entitlement-override endpoints. These wrap
 * EXISTING storage (billing_subscriptions, workspace_entitlement_overrides,
 * entitlement_override_events — see billing/plans.ts and
 * billing/entitlements.service.ts) with a PlatformAdminGuard-gated HTTP
 * surface; no new tables, no new audit mechanism.
 */

export const billingPlanIdSchema = z.enum(['free', 'pro', 'business', 'enterprise']);
export type BillingPlanId = z.infer<typeof billingPlanIdSchema>;

/** A non-empty, trimmed reason — every mutation here requires one (audited verbatim). */
const auditReasonSchema = z
  .string()
  .trim()
  .min(1, 'reason is required')
  .max(2000);

/** POST /admin/workspaces/:id/plan */
export const adminSetPlanRequestSchema = z.object({
  plan: billingPlanIdSchema,
  reason: auditReasonSchema,
  /** ISO 8601 timestamp; omit for a plan that never expires. */
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
export type AdminSetPlanRequest = z.infer<typeof adminSetPlanRequestSchema>;

/**
 * POST /admin/workspaces/:id/entitlement-overrides — a direct pass-through to
 * EntitlementsService.setOverride's own patch shape (EntitlementOverridePatch);
 * every field is independently optional/nullable — omitted means "leave
 * whatever is already set", explicit `null` means "clear this field back to
 * the plan default" (matches setOverride's upsert-by-field semantics).
 */
export const adminSetEntitlementOverrideRequestSchema = z.object({
  includedSeats: z.number().int().positive().nullable().optional(),
  automationRunsPerMonth: z.number().int().positive().nullable().optional(),
  maxWorkspaces: z.number().int().positive().nullable().optional(),
  featureFlags: z.record(z.string(), z.boolean()).nullable().optional(),
  reason: auditReasonSchema,
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
export type AdminSetEntitlementOverrideRequest = z.infer<
  typeof adminSetEntitlementOverrideRequestSchema
>;

/** DELETE /admin/workspaces/:id/entitlement-overrides body — reason only. */
export const adminClearEntitlementOverrideRequestSchema = z.object({
  reason: auditReasonSchema,
});
export type AdminClearEntitlementOverrideRequest = z.infer<
  typeof adminClearEntitlementOverrideRequestSchema
>;

/** The active override row, projected for the admin billing view. */
export const adminEntitlementOverrideViewSchema = z.object({
  includedSeats: z.number().nullable(),
  automationRunsPerMonth: z.number().nullable(),
  maxWorkspaces: z.number().nullable(),
  featureFlags: z.record(z.string(), z.boolean()).nullable(),
  reason: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  createdBy: z.string(),
  updatedAt: z.iso.datetime(),
});
export type AdminEntitlementOverrideView = z.infer<typeof adminEntitlementOverrideViewSchema>;

/** One entitlement_override_events row, as the audit trail shows it. */
export const adminEntitlementOverrideEventSchema = z.object({
  id: z.uuid(),
  actorUserId: z.string(),
  action: z.enum(['set', 'clear']),
  snapshot: z.unknown(),
  reason: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminEntitlementOverrideEvent = z.infer<typeof adminEntitlementOverrideEventSchema>;

/** GET /admin/workspaces/:id/billing — read-only plan + overrides + audit trail. */
export const adminWorkspaceBillingViewSchema = z.object({
  workspaceId: z.uuid(),
  plan: billingPlanIdSchema,
  status: z.string().nullable(),
  /**
   * Always null through this admin surface (see AdminBillingService.setPlan's
   * own doc): an admin-assigned plan never carries a live Stripe linkage, so
   * nothing downstream (e.g. BillingService.syncSeatQuantity) can mistake it
   * for a real subscription and call Stripe against it.
   */
  stripeSubscriptionId: z.string().nullable(),
  seats: z.number(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  override: adminEntitlementOverrideViewSchema.nullable(),
  auditTrail: z.array(adminEntitlementOverrideEventSchema),
});
export type AdminWorkspaceBillingView = z.infer<typeof adminWorkspaceBillingViewSchema>;
