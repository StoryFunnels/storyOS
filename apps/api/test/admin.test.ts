import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { billingSubscriptions, platformAdmins } from '../src/db/schema';
import { PLANS } from '../src/billing/plans';

let app: NestFastifyApplication;
let db: Db;
let operator: { token: string; email: string; id: string };
let regular: { token: string; email: string };

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  operator = { ...(await signUpUser(app, 'AdminOperator')), id: '' };
  regular = await signUpUser(app, 'AdminRegular');

  // Resolve the operator's real user id via /me, then grant platform_admin
  // directly — there's no HTTP grant surface yet (MN-104's own next step).
  const me = await as(operator.token, 'GET', '/me');
  operator.id = me.json().id;
  await db.insert(platformAdmins).values({ userId: operator.id, grantedBy: null });

  await as(operator.token, 'POST', '/workspaces', { name: 'Admin WS 1' });
  await as(regular.token, 'POST', '/workspaces', { name: 'Admin WS 2' });
});

afterAll(async () => {
  await app.close();
});

describe('GET /admin/overview — MN-104', () => {
  it('403s for a non-platform-admin, even one with a normal session', async () => {
    const res = await as(regular.token, 'GET', '/admin/overview');
    expect(res.statusCode).toBe(403);
  });

  it('401s with no auth at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('a platform admin sees real counts across every workspace, not just their own', async () => {
    const res = await as(operator.token, 'GET', '/admin/overview');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    // At least the 2 workspaces created in beforeAll — other test files in
    // the same run may add more, so this asserts a floor, not an exact count.
    expect(body.totalWorkspaces).toBeGreaterThanOrEqual(2);
    expect(body.totalUsers).toBeGreaterThanOrEqual(2);
    expect(body.workspacesByPlan).toHaveProperty('free');
    expect(typeof body.estimatedMrrUsd).toBe('number');
  });
});

describe('GET /admin/overview — Est. MRR counts live-mode Stripe subscriptions only (#1391)', () => {
  // Stripe subscription ids are unique in the table, so a fixed id would fail the second run on a reused database.
  const subId = (label: string) => `sub_${label}_1391_${Math.random().toString(36).slice(2, 10)}`;
  const mrr = async () => (await as(operator.token, 'GET', '/admin/overview')).json().estimatedMrrUsd as number;

  /** A fresh one-member workspace carrying exactly this subscription row. The overview is global, so each case is read as a DELTA. */
  async function withSubscription(name: string, row: Partial<typeof billingSubscriptions.$inferInsert>) {
    const created = await as(operator.token, 'POST', '/workspaces', { name });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = created.json().id as string;
    const values = { workspaceId, plan: 'pro' as const, status: 'active' as const, ...row };
    await db.insert(billingSubscriptions).values(values).onConflictDoUpdate({ target: billingSubscriptions.workspaceId, set: values });
    return workspaceId;
  }

  it('ignores a sandbox subscription, a live trial, a hand-granted plan, and a live-but-canceled one; counts a live active one', async () => {
    const base = await mrr();

    await withSubscription('Sandbox Pro', { stripeSubscriptionId: subId('sandbox'), livemode: false });
    expect(await mrr(), 'a sandbox subscription is not revenue').toBe(base);

    await withSubscription('Trial Pro', { stripeSubscriptionId: subId('trial'), livemode: true, status: 'trialing' });
    expect(await mrr(), 'a trial has not paid yet').toBe(base);

    // A plan with no Stripe subscription behind it (how an admin grant is stored). livemode and status both say "billing" here,
    // so only the missing subscription id can be what keeps it out.
    await withSubscription('Comp Pro', { stripeSubscriptionId: null, livemode: true, status: 'active' });
    expect(await mrr(), 'a plan granted by hand bills nothing').toBe(base);

    await withSubscription('Canceled Pro', { stripeSubscriptionId: subId('canceled'), livemode: true, status: 'canceled' });
    expect(await mrr(), 'a canceled subscription bills nothing').toBe(base);

    await withSubscription('Live Pro', { stripeSubscriptionId: subId('live'), livemode: true });
    expect(await mrr(), 'a live active subscription is counted at the plan price').toBe(base + PLANS.pro.priceUsd);

    await withSubscription('Live Late Pro', { stripeSubscriptionId: subId('late'), livemode: true, status: 'past_due' });
    expect(await mrr(), 'past_due is still owed, so still counted').toBe(base + 2 * PLANS.pro.priceUsd);
  });
});

describe('GET /admin/workspaces — MN-104', () => {
  it('403s for a non-platform-admin', async () => {
    const res = await as(regular.token, 'GET', '/admin/workspaces');
    expect(res.statusCode).toBe(403);
  });

  it('lists workspaces the operator does not belong to', async () => {
    const res = await as(operator.token, 'GET', '/admin/workspaces');
    expect(res.statusCode, res.body).toBe(200);
    const names = res.json().map((w: { name: string }) => w.name);
    expect(names).toContain('Admin WS 1');
    expect(names).toContain('Admin WS 2'); // operator was never invited to this one
  });

  it('each row reports plan, seats, and record count', async () => {
    const res = await as(operator.token, 'GET', '/admin/workspaces');
    const row = res.json().find((w: { name: string }) => w.name === 'Admin WS 1');
    expect(row).toMatchObject({ plan: 'free', billableSeats: 1, recordCount: 0 });
  });
});
