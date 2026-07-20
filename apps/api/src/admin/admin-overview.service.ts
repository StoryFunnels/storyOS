import { Inject, Injectable } from '@nestjs/common';
import { eq, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { billingSubscriptions, databases, records, user, workspaces } from '../db/schema';
import { AccessService } from '../access/access.service';
import { PLANS, seatOverage, SEAT_PRICE_USD, type PlanId } from '../billing/plans';

export interface AdminOverview {
  totalWorkspaces: number;
  totalUsers: number;
  totalRecords: number;
  workspacesByPlan: Record<PlanId, number>;
  /** Plan price + $12/seat overage, summed across workspaces. Not Stripe's
   * actual invoiced total (proration/timing can differ) — an operator-facing
   * estimate, not an accounting figure. */
  estimatedMrrUsd: number;
}

export interface AdminWorkspaceSummary {
  id: string;
  name: string;
  plan: PlanId;
  billableSeats: number;
  includedSeats: number;
  recordCount: number;
  createdAt: Date;
}

/**
 * MN-104 first cut — read-only, no mutations. Reads the entitlements/billing
 * catalogue rather than recomputing pricing (per the ticket's own design
 * notes). Per-workspace billable-seat lookups are one query per workspace
 * (AccessService has no bulk variant yet) — fine at today's scale, would need
 * revisiting well before thousands of workspaces.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async recordCountByWorkspace(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ workspaceId: databases.workspaceId, count: sql<number>`count(*)::int` })
      .from(records)
      .innerJoin(databases, eq(records.databaseId, databases.id))
      .where(isNull(records.deletedAt))
      .groupBy(databases.workspaceId);
    return new Map(rows.map((r) => [r.workspaceId, r.count]));
  }

  private async planByWorkspace(): Promise<Map<string, PlanId>> {
    const rows = await this.db
      .select({ workspaceId: workspaces.id, plan: billingSubscriptions.plan })
      .from(workspaces)
      .leftJoin(billingSubscriptions, eq(billingSubscriptions.workspaceId, workspaces.id));
    return new Map(rows.map((r) => [r.workspaceId, (r.plan ?? 'free') as PlanId]));
  }

  async getOverview(): Promise<AdminOverview> {
    const [workspaceCountRows, userCountRows, recordCountRows, planByWs] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(workspaces),
      this.db.select({ count: sql<number>`count(*)::int` }).from(user),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(records)
        .where(isNull(records.deletedAt)),
      this.planByWorkspace(),
    ]);
    const totalWorkspaces = workspaceCountRows[0]?.count ?? 0;
    const totalUsers = userCountRows[0]?.count ?? 0;
    const totalRecords = recordCountRows[0]?.count ?? 0;

    const workspacesByPlan = { free: 0, pro: 0, business: 0, enterprise: 0 } as Record<
      PlanId,
      number
    >;
    for (const plan of planByWs.values()) workspacesByPlan[plan]++;

    let estimatedMrrUsd = 0;
    for (const [workspaceId, plan] of planByWs) {
      if (plan === 'free') continue;
      const billable = (await this.access.billableUserIds(workspaceId)).length;
      estimatedMrrUsd += PLANS[plan].priceUsd + seatOverage(plan, billable) * SEAT_PRICE_USD;
    }

    return { totalWorkspaces, totalUsers, totalRecords, workspacesByPlan, estimatedMrrUsd };
  }

  async listWorkspaces(): Promise<AdminWorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        createdAt: workspaces.createdAt,
        plan: billingSubscriptions.plan,
      })
      .from(workspaces)
      .leftJoin(billingSubscriptions, eq(billingSubscriptions.workspaceId, workspaces.id))
      .orderBy(workspaces.createdAt);

    const [recordCounts] = await Promise.all([this.recordCountByWorkspace()]);

    return Promise.all(
      rows.map(async (r) => {
        const plan = (r.plan ?? 'free') as PlanId;
        const billableSeats = (await this.access.billableUserIds(r.id)).length;
        return {
          id: r.id,
          name: r.name,
          plan,
          billableSeats,
          includedSeats: PLANS[plan].includedSeats,
          recordCount: recordCounts.get(r.id) ?? 0,
          createdAt: r.createdAt,
        };
      }),
    );
  }
}
