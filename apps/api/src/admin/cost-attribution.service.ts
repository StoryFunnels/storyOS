import { Inject, Injectable } from '@nestjs/common';
import { eq, and, gte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  aiCreditTransactions,
  attachments,
  billingSubscriptions,
  databases,
  records,
  usageCounters,
  workspaceFiles,
  workspaces,
} from '../db/schema';
import { AccessService } from '../access/access.service';
import type { PlanId } from '../billing/plans';
import { currentMonthPeriodStart, AUTOMATION_RUN_METRIC, EMAIL_SEND_METRIC } from '../billing/usage-metering';
import {
  blendMarginByPlan,
  computeWorkspaceCost,
  FIXED_MONTHLY_INFRA_COST_USD,
  MARGIN_FLOOR_PERCENT,
  type PlanBlendedMargin,
  type WorkspaceCostRow,
} from './cost-attribution';

export interface CostOverview {
  generatedAt: string;
  marginFloorPercent: number;
  fixedMonthlyInfraCostUsd: number;
  workspaces: WorkspaceCostRow[];
  byPlan: PlanBlendedMargin[];
}

/**
 * MN-194 — reads the real usage signals other services already track (never
 * adds parallel instrumentation) and turns them into per-workspace cost and
 * margin, plus blended margin per plan, for the superadmin Cost & Margin view.
 *
 * Sources, all pre-existing:
 *  - usage_counters(metric='automation_runs') — MN-168's non-AI run counter,
 *    reused as the hosted MCP/API call-volume driver.
 *  - usage_counters(metric='email_sends') — MN-194's own new counter, but the
 *    SAME table (no schema change) — see EmailService.send.
 *  - attachments.size + workspace_files.size — MN-029/MN-097's stored byte
 *    counts, already written on every upload.
 *  - ai_credit_transactions.our_cost_cents — MN-188/MN-189's per-run AI cost
 *    ledger column; always 0 today because ManagedAiRuntime doesn't run yet
 *    (MN-214r) — surfaced honestly as a placeholder, not invented separately.
 *
 * Per-workspace queries are one round trip each (not N+1 per workspace) —
 * deliberately different from AdminOverviewService's billableUserIds loop,
 * since here workspace count concerns need whole-instance aggregates anyway.
 */
@Injectable()
export class CostAttributionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async workspaceRoster(): Promise<{ id: string; name: string; plan: PlanId }[]> {
    const rows = await this.db
      .select({ id: workspaces.id, name: workspaces.name, plan: billingSubscriptions.plan })
      .from(workspaces)
      .leftJoin(billingSubscriptions, eq(billingSubscriptions.workspaceId, workspaces.id));
    return rows.map((r) => ({ id: r.id, name: r.name, plan: (r.plan ?? 'free') as PlanId }));
  }

  private async usageCounterByWorkspace(metric: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ workspaceId: usageCounters.workspaceId, count: usageCounters.count })
      .from(usageCounters)
      .where(and(eq(usageCounters.metric, metric), eq(usageCounters.periodStart, currentMonthPeriodStart())));
    return new Map(rows.map((r) => [r.workspaceId, r.count]));
  }

  /** Bytes stored, by workspace: attachments (joined via records->databases, MN-029) + workspace_files (MN-097). Not filtered by soft-delete — orphaned bytes are still real bytes sitting in storage until a future sweep (attachments.service.ts's own documented caveat). */
  private async storageBytesByWorkspace(): Promise<Map<string, number>> {
    const [attachmentRows, fileRows] = await Promise.all([
      this.db
        .select({ workspaceId: databases.workspaceId, bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` })
        .from(attachments)
        .innerJoin(records, eq(attachments.recordId, records.id))
        .innerJoin(databases, eq(records.databaseId, databases.id))
        .groupBy(databases.workspaceId),
      this.db
        .select({ workspaceId: workspaceFiles.workspaceId, bytes: sql<number>`coalesce(sum(${workspaceFiles.size}), 0)::bigint` })
        .from(workspaceFiles)
        .groupBy(workspaceFiles.workspaceId),
    ]);
    const totals = new Map<string, number>();
    for (const row of attachmentRows) totals.set(row.workspaceId, Number(row.bytes));
    for (const row of fileRows) {
      totals.set(row.workspaceId, (totals.get(row.workspaceId) ?? 0) + Number(row.bytes));
    }
    return totals;
  }

  /** Sum of ai_credit_transactions.our_cost_cents for 'usage' rows this month, by workspace — see the class doc on why this is currently always 0. */
  private async aiCostCentsByWorkspace(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        workspaceId: aiCreditTransactions.workspaceId,
        cents: sql<number>`coalesce(sum(${aiCreditTransactions.ourCostCents}), 0)::bigint`,
      })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.type, 'usage'),
          gte(aiCreditTransactions.createdAt, currentMonthPeriodStart()),
        ),
      )
      .groupBy(aiCreditTransactions.workspaceId);
    return new Map(rows.map((r) => [r.workspaceId, Number(r.cents)]));
  }

  async getCostOverview(): Promise<CostOverview> {
    const [roster, automationRuns, emailSends, storageBytes, aiCostCents] = await Promise.all([
      this.workspaceRoster(),
      this.usageCounterByWorkspace(AUTOMATION_RUN_METRIC),
      this.usageCounterByWorkspace(EMAIL_SEND_METRIC),
      this.storageBytesByWorkspace(),
      this.aiCostCentsByWorkspace(),
    ]);

    const workspaceRows = await Promise.all(
      roster.map(async (w) => {
        const billableSeats = (await this.access.billableUserIds(w.id)).length;
        return computeWorkspaceCost({
          workspaceId: w.id,
          name: w.name,
          plan: w.plan,
          billableSeats,
          automationRunsThisMonth: automationRuns.get(w.id) ?? 0,
          storageBytes: storageBytes.get(w.id) ?? 0,
          emailSendsThisMonth: emailSends.get(w.id) ?? 0,
          aiCostCentsThisMonth: aiCostCents.get(w.id) ?? 0,
        });
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      marginFloorPercent: MARGIN_FLOOR_PERCENT,
      fixedMonthlyInfraCostUsd: FIXED_MONTHLY_INFRA_COST_USD,
      workspaces: workspaceRows,
      byPlan: blendMarginByPlan(workspaceRows),
    };
  }
}
