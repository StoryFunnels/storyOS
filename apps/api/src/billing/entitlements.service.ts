import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  entitlementOverrideEvents,
  memberships,
  usageCounters,
  workspaceEntitlementOverrides,
} from '../db/schema';
import { AccessService } from '../access/access.service';
import { env } from '../config/env';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { PLANS } from './plans';
import type { PlanId } from './plans';

export interface PlanLimits {
  automationRunsPerMonth: number;
  includedSeats: number;
}

export interface WorkspaceUsage {
  automationRunsThisMonth: number;
  billableSeats: number;
}

/** Self-host / billing-disabled: full capability, no metering (MN-168). */
const UNLIMITED: PlanLimits = { automationRunsPerMonth: Infinity, includedSeats: Infinity };

const AUTOMATION_RUN_METRIC = 'automation_runs';

/** MN-256 — EMAIL_DAILY_CAP_* env vars, keyed by plan. */
function emailDailyCapFor(plan: PlanId): number {
  const e = env();
  switch (plan) {
    case 'free':
      return e.EMAIL_DAILY_CAP_FREE;
    case 'pro':
      return e.EMAIL_DAILY_CAP_PRO;
    case 'business':
      return e.EMAIL_DAILY_CAP_BUSINESS;
    case 'enterprise':
      return e.EMAIL_DAILY_CAP_ENTERPRISE;
  }
}

/** First-of-month UTC — the natural monthly reset; no cron needed. */
function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type Capability = 'automation_run' | 'add_seat';

export interface EntitlementOverridePatch {
  includedSeats?: number | null;
  automationRunsPerMonth?: number | null;
  maxWorkspaces?: number | null;
  featureFlags?: Record<string, boolean> | null;
}

/**
 * MN-191 — owner decision 2026-07-18: multiple workspaces is an
 * ENTERPRISE-only capability for now (not Business, as MN-107 originally
 * said) — there is no Account/Organization entity to group workspaces under
 * one billing owner (ADR-0014), and building one is a real, deferred
 * undertaking, not a quick add-on. So this is a flat cap, not a per-plan
 * lookup: every self-serve plan caps at 1 workspace per admin.
 */
export const MAX_WORKSPACES_SELF_SERVE = 1;

/**
 * MN-168 — the single entitlements read path the rest of the app calls.
 * Exactly one metered line lives here: non-AI automation runs vs the plan
 * allowance. Seats are read live off AccessService (already the billing
 * boundary, MN-121); workspace count is deliberately NOT enforced here — it
 * needs the multi-workspace/account model MN-191 owns, so this service only
 * exposes the plan's limit, not a workspace-count check.
 *
 * No storage meter and no record-limit key exist anywhere in PlanLimits —
 * unlimited records is load-bearing on every plan (MN-107), and that omission
 * is itself the guarantee (see entitlements.service.test.ts).
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stripe: StripeService,
    private readonly billing: BillingService,
    private readonly access: AccessService,
  ) {}

  /**
   * Plan limits for a workspace, with any active entitlement override
   * (MN-196) applied field-by-field on top. Precedence: an override field
   * wins when set and not expired; otherwise the plan default. Self-host =
   * unlimited, no DB read at all.
   */
  async getLimits(workspaceId: string): Promise<PlanLimits> {
    if (!this.stripe.enabled) return UNLIMITED;
    const [status, override] = await Promise.all([
      this.billing.getStatus(workspaceId),
      this.getOverride(workspaceId),
    ]);
    const plan = PLANS[status.plan];
    return {
      automationRunsPerMonth: override?.automationRunsPerMonth ?? plan.automationRuns,
      includedSeats: override?.includedSeats ?? plan.includedSeats,
    };
  }

  /**
   * MN-256 — send_email's daily send cap for a workspace's plan. Deliberately
   * NOT wired through `getLimits`/`PlanLimits`/entitlement overrides: those
   * are monthly, and per-seat/automation-run scoped in a way a per-DAY email
   * cap isn't yet a clean fit for — see EMAIL_DAILY_CAP_* env vars' own
   * comment for the TODO to fold this into a real per-capability entitlement
   * once the billing epic grows one. Self-host (Stripe disabled) is
   * unlimited, same as every other entitlement here.
   */
  async emailDailyCap(workspaceId: string): Promise<number> {
    if (!this.stripe.enabled) return Infinity;
    const status = await this.billing.getStatus(workspaceId);
    return emailDailyCapFor(status.plan);
  }

  /**
   * The workspace's active entitlement override row, or undefined if none
   * exists or it has expired. Lazy check-on-read (same pattern as MN-192's
   * trial-expiry sweep): an expired override is ignored here but never
   * deleted — entitlement_override_events keeps the full history regardless.
   */
  async getOverride(workspaceId: string) {
    const row = await this.db.query.workspaceEntitlementOverrides.findFirst({
      where: eq(workspaceEntitlementOverrides.workspaceId, workspaceId),
    });
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    return row;
  }

  /**
   * Set (or replace) a workspace's entitlement override — the delivery
   * mechanism for Enterprise contracts, comps, grandfathering, and temporary
   * support grants (MN-196). `reason` is required; every call is recorded in
   * entitlement_override_events regardless of whether anything actually
   * changed, so "who granted what, why, until when" is always answerable.
   * MN-104's admin panel is the intended caller — this is the seam it uses.
   */
  async setOverride(
    workspaceId: string,
    actorUserId: string,
    patch: EntitlementOverridePatch,
    reason: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(workspaceEntitlementOverrides)
        .values({ workspaceId, ...patch, reason, expiresAt, createdBy: actorUserId })
        .onConflictDoUpdate({
          target: workspaceEntitlementOverrides.workspaceId,
          set: { ...patch, reason, expiresAt, createdBy: actorUserId, updatedAt: new Date() },
        })
        .returning();
      await tx.insert(entitlementOverrideEvents).values({
        workspaceId,
        actorUserId,
        action: 'set',
        snapshot: row,
        reason,
        expiresAt,
      });
    });
  }

  /**
   * Clear a workspace's override entirely — reverts to plan defaults. The
   * row is deleted (not just expired) but the audit trail is preserved via
   * entitlement_override_events, which snapshots what was cleared.
   */
  async clearOverride(workspaceId: string, actorUserId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .delete(workspaceEntitlementOverrides)
        .where(eq(workspaceEntitlementOverrides.workspaceId, workspaceId))
        .returning();
      if (!existing) return;
      await tx.insert(entitlementOverrideEvents).values({
        workspaceId,
        actorUserId,
        action: 'clear',
        snapshot: existing,
        reason,
        expiresAt: null,
      });
    });
  }

  /**
   * Current usage. Seats are always live (cheap, and MN-190 needs it correct
   * even when billing is off). Self-host never reads the run counter — no
   * phone-home, and no query overhead for a number nobody enforces.
   */
  async getUsage(workspaceId: string): Promise<WorkspaceUsage> {
    const billableSeats = (await this.access.billableUserIds(workspaceId)).length;
    if (!this.stripe.enabled) return { automationRunsThisMonth: 0, billableSeats };

    const row = await this.db.query.usageCounters.findFirst({
      where: and(
        eq(usageCounters.workspaceId, workspaceId),
        eq(usageCounters.periodStart, currentPeriodStart()),
        eq(usageCounters.metric, AUTOMATION_RUN_METRIC),
      ),
    });
    return { automationRunsThisMonth: row?.count ?? 0, billableSeats };
  }

  /**
   * Capability check — the one thing automations/agents dispatch (and now
   * MN-190's invite/role-change paths) call before acting. Self-host
   * short-circuits to true before any query.
   */
  async can(workspaceId: string, capability: Capability): Promise<boolean> {
    if (!this.stripe.enabled) return true;
    if (capability === 'automation_run') {
      const [limits, usage] = await Promise.all([
        this.getLimits(workspaceId),
        this.getUsage(workspaceId),
      ]);
      return usage.automationRunsThisMonth < limits.automationRunsPerMonth;
    }
    if (capability === 'add_seat') {
      // MN-190: Free has no seat-overage price — it is the only real ceiling.
      // Pro/Business always allow another seat; it just bills $12/mo more.
      const status = await this.billing.getStatus(workspaceId);
      if (status.plan !== 'free') return true;
      const [limits, usage] = await Promise.all([
        this.getLimits(workspaceId),
        this.getUsage(workspaceId),
      ]);
      return usage.billableSeats < limits.includedSeats;
    }
    return true;
  }

  /**
   * MN-191 — a userId check, not a workspaceId one: the workspace being
   * created doesn't exist yet, so there is nothing to look a plan up on.
   * Self-host short-circuits to true (no cap) before any query, same as
   * every other check here.
   *
   * MN-196: an Enterprise/comp'd account raises this via a `maxWorkspaces`
   * override set on one of their EXISTING workspaces (there's always at
   * least one — you can't override a workspace before it exists). The
   * highest active override across their owned workspaces wins; with none,
   * the flat self-serve cap applies.
   */
  async canCreateWorkspace(userId: string): Promise<boolean> {
    if (!this.stripe.enabled) return true;
    const owned = await this.db.query.memberships.findMany({
      where: and(
        eq(memberships.userId, userId),
        eq(memberships.role, 'admin'),
        eq(memberships.status, 'active'),
      ),
    });
    if (owned.length === 0) return true;
    const limit = await this.maxWorkspacesFor(owned.map((m) => m.workspaceId));
    return owned.length < limit;
  }

  /** Highest active maxWorkspaces override across the given workspaces, or the flat self-serve cap if none apply. */
  private async maxWorkspacesFor(workspaceIds: string[]): Promise<number> {
    const overrides = await this.db.query.workspaceEntitlementOverrides.findMany({
      where: inArray(workspaceEntitlementOverrides.workspaceId, workspaceIds),
    });
    const now = Date.now();
    const active = overrides
      .filter((o) => !o.expiresAt || o.expiresAt.getTime() > now)
      .map((o) => o.maxWorkspaces)
      .filter((v): v is number => v != null);
    return active.length > 0 ? Math.max(...active) : MAX_WORKSPACES_SELF_SERVE;
  }

  /**
   * Record one non-AI run against the monthly allowance — the ONLY write path
   * onto usage_counters. Every call site is gated on `runClass === 'non_ai'`
   * (agent dispatch) or is the automations engine, which never invokes AI at
   * all: there is no code path from a your-own-AI or StoryOS-AI run to this
   * method, which is what makes MN-188's "never metered" promise structural
   * rather than a rule someone could forget to apply.
   *
   * Self-host never increments — no phone-home, zero counting overhead.
   */
  async recordNonAiRun(workspaceId: string): Promise<void> {
    if (!this.stripe.enabled) return;
    const periodStart = currentPeriodStart();
    await this.db
      .insert(usageCounters)
      .values({ workspaceId, periodStart, metric: AUTOMATION_RUN_METRIC, count: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.periodStart, usageCounters.metric],
        set: { count: sql`${usageCounters.count} + 1` },
      });
  }
}
