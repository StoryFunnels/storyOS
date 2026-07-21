import { describe, expect, it } from 'vitest';
import {
  AI_COST_IS_PLACEHOLDER,
  MARGIN_FLOOR_PERCENT,
  blendMarginByPlan,
  computeWorkspaceCost,
  estimatedRevenueCents,
} from './cost-attribution';

describe('estimatedRevenueCents — MN-194', () => {
  it('is $0 for Free regardless of seats (no overage price on Free)', () => {
    expect(estimatedRevenueCents('free', 1)).toBe(0);
    expect(estimatedRevenueCents('free', 10)).toBe(0);
  });

  it('is the base price in cents for Pro/Business within included seats', () => {
    expect(estimatedRevenueCents('pro', 1)).toBe(2900);
    expect(estimatedRevenueCents('business', 5)).toBe(9900);
  });

  it('adds the $12/seat overage beyond the included tier', () => {
    // Pro includes 3 seats; 5 billable seats = 2 over.
    expect(estimatedRevenueCents('pro', 5)).toBe(2900 + 2 * 1200);
  });

  it('is $0 for Enterprise — no self-serve number to project (negotiated out-of-band)', () => {
    expect(estimatedRevenueCents('enterprise', 50)).toBe(0);
  });
});

describe('computeWorkspaceCost — MN-194', () => {
  it('computes each cost line from real usage inputs and sums them into variableCostCents', () => {
    const row = computeWorkspaceCost({
      workspaceId: 'ws1',
      name: 'Acme',
      plan: 'pro',
      billableSeats: 3,
      automationRunsThisMonth: 1000, // 1000 * 0.00005 * 100 = 5 cents
      storageBytes: 1024 ** 3, // exactly 1 GB -> 2.3 cents -> rounds to 2
      emailSendsThisMonth: 100, // 100 * 0.001 * 100 = 10 cents
      aiCostCentsThisMonth: 0,
    });

    expect(row.hostedCallsCostCents).toBe(5);
    expect(row.storageCostCents).toBe(2);
    expect(row.emailCostCents).toBe(10);
    expect(row.aiCostCents).toBe(0);
    expect(row.aiCostIsPlaceholder).toBe(AI_COST_IS_PLACEHOLDER);
    expect(row.variableCostCents).toBe(5 + 2 + 10);
    expect(row.revenueCents).toBe(2900);
    expect(row.marginCents).toBe(2900 - 17);
    expect(row.marginPercent).toBeCloseTo(((2900 - 17) / 2900) * 100, 5);
  });

  it('reports marginPercent as null (not -Infinity) for Free — there is no revenue to divide by', () => {
    const row = computeWorkspaceCost({
      workspaceId: 'ws2',
      name: 'Freebie',
      plan: 'free',
      billableSeats: 2,
      automationRunsThisMonth: 100_000, // a lot of hosted calls, $0 revenue
      storageBytes: 0,
      emailSendsThisMonth: 0,
      aiCostCentsThisMonth: 0,
    });
    expect(row.revenueCents).toBe(0);
    expect(row.marginPercent).toBeNull();
  });

  it('never flags Free plan workspaces below the margin floor — Free is subsidized by design', () => {
    const row = computeWorkspaceCost({
      workspaceId: 'ws3',
      name: 'Heavy Free User',
      plan: 'free',
      billableSeats: 2,
      automationRunsThisMonth: 10_000_000, // huge cost, still Free
      storageBytes: 500 * 1024 ** 3,
      emailSendsThisMonth: 10_000,
      aiCostCentsThisMonth: 0,
    });
    expect(row.belowMarginFloor).toBe(false);
  });

  it('flags a paying workspace whose margin drops below MARGIN_FLOOR_PERCENT', () => {
    const row = computeWorkspaceCost({
      workspaceId: 'ws4',
      name: 'Underwater Pro',
      plan: 'pro', // $29 revenue
      billableSeats: 3,
      automationRunsThisMonth: 40_000_000, // 40,000,000 * 0.00005 * 100 = $2000 -> way over $29
      storageBytes: 0,
      emailSendsThisMonth: 0,
      aiCostCentsThisMonth: 0,
    });
    expect(row.marginPercent).toBeLessThan(MARGIN_FLOOR_PERCENT);
    expect(row.belowMarginFloor).toBe(true);
  });

  it('does not flag a healthy paying workspace', () => {
    const row = computeWorkspaceCost({
      workspaceId: 'ws5',
      name: 'Healthy Pro',
      plan: 'pro',
      billableSeats: 3,
      automationRunsThisMonth: 500,
      storageBytes: 0,
      emailSendsThisMonth: 10,
      aiCostCentsThisMonth: 0,
    });
    expect(row.belowMarginFloor).toBe(false);
  });
});

describe('blendMarginByPlan — MN-194', () => {
  it('aggregates revenue/cost per plan and allocates fixed cost proportional to workspace count', () => {
    const rows = [
      computeWorkspaceCost({
        workspaceId: 'a',
        name: 'A',
        plan: 'pro',
        billableSeats: 1,
        automationRunsThisMonth: 0,
        storageBytes: 0,
        emailSendsThisMonth: 0,
        aiCostCentsThisMonth: 0,
      }),
      computeWorkspaceCost({
        workspaceId: 'b',
        name: 'B',
        plan: 'pro',
        billableSeats: 1,
        automationRunsThisMonth: 0,
        storageBytes: 0,
        emailSendsThisMonth: 0,
        aiCostCentsThisMonth: 0,
      }),
      computeWorkspaceCost({
        workspaceId: 'c',
        name: 'C',
        plan: 'free',
        billableSeats: 1,
        automationRunsThisMonth: 0,
        storageBytes: 0,
        emailSendsThisMonth: 0,
        aiCostCentsThisMonth: 0,
      }),
    ];

    const byPlan = blendMarginByPlan(rows, 300); // $300/month fixed, 3 workspaces total -> $100 each

    const pro = byPlan.find((p) => p.plan === 'pro')!;
    const free = byPlan.find((p) => p.plan === 'free')!;

    expect(pro.workspaceCount).toBe(2);
    expect(pro.revenueCents).toBe(2900 * 2);
    // 2 of 3 workspaces on pro -> 2/3 of $300 = $200 = 20000 cents
    expect(pro.allocatedFixedCostCents).toBe(20000);
    expect(pro.totalCostCents).toBe(pro.variableCostCents + 20000);
    expect(pro.marginCents).toBe(pro.revenueCents - pro.totalCostCents);

    expect(free.workspaceCount).toBe(1);
    expect(free.revenueCents).toBe(0);
    expect(free.marginPercent).toBeNull();
    // 1 of 3 workspaces -> 1/3 of $300 = $100 = 10000 cents
    expect(free.allocatedFixedCostCents).toBe(10000);
  });

  it('omits plans with no workspaces entirely', () => {
    const rows = [
      computeWorkspaceCost({
        workspaceId: 'a',
        name: 'A',
        plan: 'business',
        billableSeats: 1,
        automationRunsThisMonth: 0,
        storageBytes: 0,
        emailSendsThisMonth: 0,
        aiCostCentsThisMonth: 0,
      }),
    ];
    const byPlan = blendMarginByPlan(rows, 100);
    expect(byPlan.map((p) => p.plan)).toEqual(['business']);
  });
});
