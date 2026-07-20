import type { PlanId } from '../billing/plans';
import { PLANS, SEAT_PRICE_USD, seatOverage } from '../billing/plans';

/**
 * MN-194 — makes MN-167's (#58) paper COGS model live. Everything in this
 * file is pure (no DB) so the arithmetic is unit-testable on its own;
 * cost-attribution.service.ts does the DB fetching and calls into these.
 *
 * Unit-cost assumptions below are OPERATOR-SET RATES, not measured per-tenant
 * cloud billing — StoryOS has no AWS Cost Explorer tagging or per-request
 * Cloudflare cost split wired up (that would be its own, much larger,
 * ticket). They convert real, measured usage (call counts, bytes stored,
 * email sends — all real) into a dollar estimate using public list prices or
 * a deliberately conservative guess, the same spirit as
 * AI_CREDIT_MARKUP_MULTIPLIER in plans.ts ("provisional... to be revisited
 * once real consumption data exists"). Update these constants as real
 * invoices come in — that reconciliation IS how this feeds back into MN-167.
 */

/** Hosted MCP/API call compute — a conservative per-call estimate (fractions of a cent). */
export const HOSTED_CALL_COST_USD_PER_CALL = 0.00005;

/** S3 Standard list price, USD per GB stored per month. */
export const STORAGE_COST_USD_PER_GB_MONTH = 0.023;
const BYTES_PER_GB = 1024 ** 3;

/** Resend's list price ballpark, USD per email sent. */
export const EMAIL_COST_USD_PER_SEND = 0.001;

/**
 * Fixed platform infra NOT attributable to any single workspace: base
 * compute, the Postgres instance, Cloudflare, Stripe's own fees. Amortized
 * (allocated) across active workspaces on each plan, proportional to
 * workspace count — the simplest defensible split absent real per-tenant
 * cost telemetry, and exactly what the ticket's "blended margin per plan"
 * phrasing calls for. Update monthly from the actual hosting/Stripe invoice.
 */
export const FIXED_MONTHLY_INFRA_COST_USD = 500;

/**
 * The margin floor: a workspace on a PAYING plan (Free is subsidized by
 * design — MN-107) whose contribution margin (revenue minus its own
 * attributable variable cost) drops below this percentage is flagged for a
 * human to look at. Same detection-only spirit as MN-195's fair-use guard —
 * this never blocks or throttles anything, only surfaces the workspace in
 * the superadmin panel. Tunable; not a cap.
 */
export const MARGIN_FLOOR_PERCENT = 20;

/**
 * ai_credit_transactions.our_cost_cents is MN-188/MN-189's per-run AI cost
 * ledger column — the same signal this line reuses rather than computing a
 * separate estimate. It is real infrastructure, but not yet real MONEY:
 * ManagedAiRuntime (agent-runtime.ts) still throws "not configured" and
 * pickRuntime never selects it, so no run is classified storyos_ai yet — the
 * column sums to $0 today. Once MN-188 wires a caller (see
 * AgentsService.chargeStoryOsAiRun and plans.ts's
 * STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS), it will start summing a flat,
 * clearly-labeled PLACEHOLDER per run — still not real tokens, still blocked
 * on MN-214r for that. Either way, this flag is what tells the UI to label
 * the AI line "estimated, pending real runtime" rather than presenting
 * whatever number shows up as precise.
 */
export const AI_COST_IS_PLACEHOLDER = true;

export interface WorkspaceUsageInputs {
  workspaceId: string;
  name: string;
  plan: PlanId;
  billableSeats: number;
  /** Real count: usage_counters(metric='automation_runs'), this period. */
  automationRunsThisMonth: number;
  /** Real bytes: sum(attachments.size) + sum(workspace_files.size). */
  storageBytes: number;
  /** Real count: usage_counters(metric='email_sends'), this period. */
  emailSendsThisMonth: number;
  /** Real (but currently always 0 pending MN-214r): sum(ai_credit_transactions.our_cost_cents), this period. */
  aiCostCentsThisMonth: number;
}

export interface WorkspaceCostRow {
  workspaceId: string;
  name: string;
  plan: PlanId;
  billableSeats: number;
  revenueCents: number;
  hostedCallsCostCents: number;
  storageCostCents: number;
  emailCostCents: number;
  aiCostCents: number;
  aiCostIsPlaceholder: boolean;
  /** Sum of the four lines above — the workspace's own attributable cost (fixed infra is NOT included, see FIXED_MONTHLY_INFRA_COST_USD). */
  variableCostCents: number;
  /** revenueCents - variableCostCents. Contribution margin, not "true" profit (fixed costs aren't allocated per-workspace). */
  marginCents: number;
  /** null when revenueCents is 0 (Free plan) — "N/A", not negative infinity. */
  marginPercent: number | null;
  /** Only ever true for a paying plan — Free is subsidized by design and never flagged. */
  belowMarginFloor: boolean;
}

export interface PlanBlendedMargin {
  plan: PlanId;
  workspaceCount: number;
  revenueCents: number;
  variableCostCents: number;
  /** This plan's proportional share of FIXED_MONTHLY_INFRA_COST_USD, by workspace count. */
  allocatedFixedCostCents: number;
  totalCostCents: number;
  marginCents: number;
  marginPercent: number | null;
}

/** Monthly revenue estimate for one workspace — base price + seat overage (mirrors AdminOverviewService.getOverview's per-workspace MRR term). */
export function estimatedRevenueCents(plan: PlanId, billableSeats: number): number {
  const def = PLANS[plan];
  if (!Number.isFinite(def.priceUsd)) return 0; // Enterprise: negotiated out-of-band, no self-serve number to project
  const overage = seatOverage(plan, billableSeats);
  return Math.round((def.priceUsd + overage * SEAT_PRICE_USD) * 100);
}

export function computeWorkspaceCost(input: WorkspaceUsageInputs): WorkspaceCostRow {
  const revenueCents = estimatedRevenueCents(input.plan, input.billableSeats);
  const hostedCallsCostCents = Math.round(
    input.automationRunsThisMonth * HOSTED_CALL_COST_USD_PER_CALL * 100,
  );
  const storageCostCents = Math.round(
    (input.storageBytes / BYTES_PER_GB) * STORAGE_COST_USD_PER_GB_MONTH * 100,
  );
  const emailCostCents = Math.round(input.emailSendsThisMonth * EMAIL_COST_USD_PER_SEND * 100);
  const aiCostCents = input.aiCostCentsThisMonth;
  const variableCostCents = hostedCallsCostCents + storageCostCents + emailCostCents + aiCostCents;
  const marginCents = revenueCents - variableCostCents;
  const marginPercent = revenueCents > 0 ? (marginCents / revenueCents) * 100 : null;
  const belowMarginFloor =
    input.plan !== 'free' && marginPercent !== null && marginPercent < MARGIN_FLOOR_PERCENT;

  return {
    workspaceId: input.workspaceId,
    name: input.name,
    plan: input.plan,
    billableSeats: input.billableSeats,
    revenueCents,
    hostedCallsCostCents,
    storageCostCents,
    emailCostCents,
    aiCostCents,
    aiCostIsPlaceholder: AI_COST_IS_PLACEHOLDER,
    variableCostCents,
    marginCents,
    marginPercent,
    belowMarginFloor,
  };
}

/**
 * Blended margin per plan (ticket AC) — aggregates the per-workspace rows and
 * amortizes FIXED_MONTHLY_INFRA_COST_USD across them proportional to
 * workspace count across the WHOLE instance (not just this plan), per the
 * simple allocation method documented above.
 */
export function blendMarginByPlan(
  rows: WorkspaceCostRow[],
  fixedMonthlyInfraCostUsd: number = FIXED_MONTHLY_INFRA_COST_USD,
): PlanBlendedMargin[] {
  const totalWorkspaces = rows.length;
  const fixedCostCents = Math.round(fixedMonthlyInfraCostUsd * 100);
  const byPlan = new Map<PlanId, WorkspaceCostRow[]>();
  for (const row of rows) {
    const list = byPlan.get(row.plan) ?? [];
    list.push(row);
    byPlan.set(row.plan, list);
  }

  const plans: PlanId[] = ['free', 'pro', 'business', 'enterprise'];
  return plans
    .filter((plan) => byPlan.has(plan))
    .map((plan) => {
      const planRows = byPlan.get(plan)!;
      const workspaceCount = planRows.length;
      const revenueCents = planRows.reduce((sum, r) => sum + r.revenueCents, 0);
      const variableCostCents = planRows.reduce((sum, r) => sum + r.variableCostCents, 0);
      const allocatedFixedCostCents =
        totalWorkspaces > 0 ? Math.round((fixedCostCents * workspaceCount) / totalWorkspaces) : 0;
      const totalCostCents = variableCostCents + allocatedFixedCostCents;
      const marginCents = revenueCents - totalCostCents;
      const marginPercent = revenueCents > 0 ? (marginCents / revenueCents) * 100 : null;

      return {
        plan,
        workspaceCount,
        revenueCents,
        variableCostCents,
        allocatedFixedCostCents,
        totalCostCents,
        marginCents,
        marginPercent,
      };
    });
}
