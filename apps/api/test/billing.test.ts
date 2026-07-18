import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'BillingAdmin');
  member = await signUpUser(app, 'BillingMember');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Billing WS' })).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('GET /billing — MN-166 status shape', () => {
  it('reports billing as disabled (no STRIPE_SECRET_KEY in test env) — self-host shape', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/billing`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.plan).toBe('free');
    expect(body.enabled).toBe(false);
    // Unlimited serializes as null over JSON (Infinity has no JSON representation) —
    // the frontend's job is to treat null as unlimited, not to see a real number.
    expect(body.limits.automationRunsPerMonth).toBeNull();
    expect(body.limits.includedSeats).toBeNull();
  });

  it('seats reflect billable members live, even with billing disabled', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/billing`);
    // admin + member are both billable (viewers/guests would not be).
    expect(res.json().usage.billableSeats).toBe(2);
  });

  it('is admin-only — a member gets 403', async () => {
    const res = await as(member.token, 'GET', `/workspaces/${wsId}/billing`);
    expect(res.statusCode).toBe(403);
  });
});

describe('checkout/portal — MN-166: a clear signal when billing is not configured', () => {
  it('checkout 404s on the missing price — a specific, actionable error, not a crash', async () => {
    // Price ids are checked before the Stripe client, so an unconfigured
    // instance gets "no price for 'pro'" rather than a generic 503 here.
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/billing/checkout`, { plan: 'pro' });
    expect(res.statusCode).toBe(404);
  });

  it('portal 503s — no price lookup on this path, so it reaches the Stripe-disabled check', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/billing/portal`);
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /billing/trial — MN-192: the no-card trial works regardless of Stripe config', () => {
  it('starts a 30-day Pro trial with no Stripe subscription', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/billing/trial`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().plan).toBe('pro');
    expect(res.json().trialEndsAt).toBeTruthy();
  });

  it('is idempotent — calling it again on an active trial is a no-op', async () => {
    const before = await as(admin.token, 'GET', `/workspaces/${wsId}/billing`);
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/billing/trial`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().trialEndsAt).toBe(before.json().trialEndsAt);
  });
});
