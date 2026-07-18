import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, usageCounters } from '../db/schema';
import { AccessService } from '../access/access.service';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { PLANS } from './plans';

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

/** First-of-month UTC — the natural monthly reset; no cron needed. */
function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type Capability = 'automation_run' | 'add_seat';

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

  /** Plan limits for a workspace. Self-host = unlimited, no DB read at all. */
  async getLimits(workspaceId: string): Promise<PlanLimits> {
    if (!this.stripe.enabled) return UNLIMITED;
    const status = await this.billing.getStatus(workspaceId);
    const plan = PLANS[status.plan];
    return { automationRunsPerMonth: plan.automationRuns, includedSeats: plan.includedSeats };
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
    return owned.length < MAX_WORKSPACES_SELF_SERVE;
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
