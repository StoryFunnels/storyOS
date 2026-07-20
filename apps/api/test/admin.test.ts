import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { platformAdmins } from '../src/db/schema';

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
