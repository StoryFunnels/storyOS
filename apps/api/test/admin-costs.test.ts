import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { aiCreditTransactions, platformAdmins, usageCounters, workspaceFiles } from '../src/db/schema';
import { currentMonthPeriodStart } from '../src/billing/usage-metering';
import { MARGIN_FLOOR_PERCENT } from '../src/admin/cost-attribution';

let app: NestFastifyApplication;
let db: Db;
let operator: { token: string; email: string; id: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

describe('GET /admin/costs — MN-194', () => {
  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    operator = { ...(await signUpUser(app, 'CostAdminOperator')), id: '' };

    const me = await as(operator.token, 'GET', '/me');
    operator.id = me.json().id;
    await db.insert(platformAdmins).values({ userId: operator.id, grantedBy: null });

    const wsRes = await as(operator.token, 'POST', '/workspaces', { name: 'Cost WS 1' });
    wsId = wsRes.json().id;

    // Real usage signals, inserted directly (this integration test targets the
    // read/aggregation path, not the write paths already covered by
    // entitlements.service.test.ts / email.service.test.ts / abuse-flags tests).
    const periodStart = currentMonthPeriodStart();
    await db.insert(usageCounters).values([
      { workspaceId: wsId, periodStart, metric: 'automation_runs', count: 2_000_000 }, // deliberately large -> visible cost
      { workspaceId: wsId, periodStart, metric: 'email_sends', count: 50 },
    ]);
    await db.insert(workspaceFiles).values({
      workspaceId: wsId,
      filename: 'test.png',
      mime: 'image/png',
      size: 1024 ** 3, // 1 GB
      storageKey: 'test/key',
    });
    await db.insert(aiCreditTransactions).values({
      workspaceId: wsId,
      type: 'usage',
      amountCents: -10,
      ourCostCents: 5,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('403s for a non-platform-admin', async () => {
    const regular = await signUpUser(app, 'CostAdminRegular');
    const res = await as(regular.token, 'GET', '/admin/costs');
    expect(res.statusCode).toBe(403);
  });

  it('401s with no auth at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/costs' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the margin floor and fixed-cost config alongside per-workspace and per-plan rows', async () => {
    const res = await as(operator.token, 'GET', '/admin/costs');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.marginFloorPercent).toBe(MARGIN_FLOOR_PERCENT);
    expect(typeof body.fixedMonthlyInfraCostUsd).toBe('number');
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(Array.isArray(body.byPlan)).toBe(true);
  });

  it('attributes real usage (calls, storage, email) to the workspace that generated it', async () => {
    const res = await as(operator.token, 'GET', '/admin/costs');
    const row = res.json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === wsId);

    expect(row).toBeDefined();
    // 2,000,000 automation runs at $0.00005/call = $100 = 10000 cents
    expect(row.hostedCallsCostCents).toBe(10_000);
    // 1 GB at $0.023/GB-month = 2.3 cents -> rounds to 2
    expect(row.storageCostCents).toBe(2);
    // 50 emails at $0.001/email = 5 cents
    expect(row.emailCostCents).toBe(5);
    // ai_credit_transactions.our_cost_cents summed
    expect(row.aiCostCents).toBe(5);
    expect(row.aiCostIsPlaceholder).toBe(true);
  });

  it('flags this workspace as below the margin floor — its cost dwarfs Free\'s $0 revenue is N/A, so it must be on a paying plan to flag; on Free it never flags', async () => {
    const res = await as(operator.token, 'GET', '/admin/costs');
    const row = res.json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === wsId);
    // This workspace was created on the Free plan (no checkout run) — Free
    // is never flagged by design (MN-107: subsidized), even though its
    // measured cost here is large. That IS the assertion this test protects.
    expect(row.plan).toBe('free');
    expect(row.belowMarginFloor).toBe(false);
    expect(row.marginPercent).toBeNull();
  });
});
