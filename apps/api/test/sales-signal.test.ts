import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { workspaces } from '../src/db/schema';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { BillingService } from '../src/billing/billing.service';
import type { BillingStatus } from '../src/billing/billing.service';

/**
 * #650 AC2 — the sales-signal touch: a Free workspace's blocked seat-add, a
 * Pro workspace reaching 5 billable seats, or a Free/Pro workspace's 5th
 * database, fire ONE combined per-workspace signal (email + an
 * AdminWorkspaceSummary flag), whichever happens first.
 *
 * Stripe is unset in this test env (self-host mode), so BillingService
 * always reports Free and EntitlementsService.can() always allows — same
 * constraint seat-billing.test.ts documents. Both are spied on the real
 * singletons (not re-implemented) to simulate the plan state each scenario
 * needs, proving the wiring, not the pricing math.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function freshWorkspace(name: string) {
  const wsId = (await as(admin.token, 'POST', '/workspaces', { name })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  return { wsId, spaceId };
}

async function inviteAndAccept(wsId: string, name: string, role: 'member' | 'guest', grants?: unknown[]) {
  const newUser = await signUpUser(app, name);
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: newUser.email,
    role,
    ...(grants ? { grants } : {}),
  });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.body}`);
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accept = await as(newUser.token, 'POST', '/invites/accept', { token });
  if (accept.statusCode !== 201) throw new Error(`accept failed: ${accept.body}`);
  return newUser;
}

async function salesSignalRow(wsId: string) {
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
  return { sentAt: row?.salesSignalSentAt ?? null, reason: row?.salesSignalReason ?? null };
}

/** Waits for the fire-and-forget maybeFire/checkSeatCrossing/checkDatabaseCrossing
 * call (never awaited by the caller, by design) to land — same polling
 * convention ai-field.test.ts's waitForJobAndTick uses for its own
 * fire-and-forget domain-event path. */
async function waitForSalesSignal(wsId: string): Promise<{ sentAt: string | null; reason: string | null }> {
  for (let i = 0; i < 40; i++) {
    const row = await salesSignalRow(wsId);
    if (row.sentAt) return row as { sentAt: string; reason: string };
    await new Promise((r) => setTimeout(r, 25));
  }
  return salesSignalRow(wsId) as Promise<{ sentAt: null; reason: null }>;
}

function forceSeatBlocked(wsId: string) {
  const entitlements = app.get(EntitlementsService);
  const original = entitlements.can.bind(entitlements);
  entitlements.can = vi.fn(async (workspaceId: string, capability) =>
    workspaceId === wsId && capability === 'add_seat' ? false : original(workspaceId, capability),
  );
  return () => {
    entitlements.can = original;
  };
}

function forcePlan(wsId: string, plan: BillingStatus['plan']) {
  const billing = app.get(BillingService);
  const original = billing.getStatus.bind(billing);
  billing.getStatus = vi.fn(async (workspaceId: string) =>
    workspaceId === wsId
      ? ({ plan, status: null, seats: 0, cancelAtPeriodEnd: false, currentPeriodEnd: null, trialEndsAt: null } as BillingStatus)
      : original(workspaceId),
  );
  return () => {
    billing.getStatus = original;
  };
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'SalesSignalAdmin');
});

afterAll(async () => {
  await app.close();
});

describe('#650 AC2 — sales-signal triggers', () => {
  it('fires free_seats_blocked at the existing add_seat rejection, never a new detection path', async () => {
    const { wsId } = await freshWorkspace('Free Blocked WS');
    const restore = forceSeatBlocked(wsId);
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
        email: 'blocked@storyos.local',
        role: 'member',
      });
      expect(res.statusCode, res.body).toBe(402);
    } finally {
      restore();
    }
    const fired = await waitForSalesSignal(wsId);
    expect(fired.reason).toBe('free_seats_blocked');
    expect(fired.sentAt).toBeTruthy();
  });

  it('fires pro_five_seats exactly when billable seats crosses to 5, not before and not again after', async () => {
    const { wsId, spaceId } = await freshWorkspace('Pro Five Seats WS');
    const restorePlan = forcePlan(wsId, 'pro');
    try {
      // Admin is seat #1. Add 3 more (members 2-4) — no signal yet, still below 5.
      await inviteAndAccept(wsId, 'ProSeat2', 'member');
      await inviteAndAccept(wsId, 'ProSeat3', 'member');
      await inviteAndAccept(wsId, 'ProSeat4', 'member');
      await new Promise((r) => setTimeout(r, 100));
      expect((await salesSignalRow(wsId)).reason).toBeNull();

      // The 5th billable seat — via a guest promoted to member, exercising
      // MembersService.update()'s crossing check, not just InvitesService's.
      const guest = await signUpUser(app, 'ProSeat5Guest');
      const guestInvite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
        email: guest.email,
        role: 'guest',
        grants: [{ space_id: spaceId, role: 'viewer' }],
      });
      const guestToken = new URL(guestInvite.json().accept_url).searchParams.get('token')!;
      await as(guest.token, 'POST', '/invites/accept', { token: guestToken });
      const members = await as(admin.token, 'GET', `/workspaces/${wsId}/members`);
      const guestMembership = members.json().find((m: { user: { email: string } }) => m.user.email === guest.email);
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/members/${guestMembership.id}`, { role: 'member' });

      const fired = await waitForSalesSignal(wsId);
      expect(fired.reason).toBe('pro_five_seats');
    } finally {
      restorePlan();
    }
  });

  it('fires fifth_database exactly on the database whose creation crosses to 5', async () => {
    const { wsId, spaceId } = await freshWorkspace('Fifth Database WS');
    for (let i = 1; i <= 4; i++) {
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `DB ${i}` });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect((await salesSignalRow(wsId)).reason).toBeNull();

    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'DB 5' });
    const fired = await waitForSalesSignal(wsId);
    expect(fired.reason).toBe('fifth_database');
  });

  it('fires only ONCE per workspace lifetime — a second real trigger does not overwrite the first reason', async () => {
    const { wsId, spaceId } = await freshWorkspace('Fire Once WS');
    for (let i = 1; i <= 5; i++) {
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `DB ${i}` });
    }
    const first = await waitForSalesSignal(wsId);
    expect(first.reason).toBe('fifth_database');

    const restore = forceSeatBlocked(wsId);
    try {
      await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: 'second-trigger@storyos.local', role: 'member' });
    } finally {
      restore();
    }
    await new Promise((r) => setTimeout(r, 100));
    const stillFirst = await salesSignalRow(wsId);
    expect(stillFirst.reason).toBe('fifth_database'); // unchanged — free_seats_blocked never overwrote it
  });

  it("a system database's creation is excluded from the count and never triggers the signal", async () => {
    const { wsId } = await freshWorkspace('System DB Exempt WS');
    const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(ensured.statusCode, ensured.body).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    expect((await salesSignalRow(wsId)).reason).toBeNull();
  });

  it("AdminOverviewService surfaces the flag and reason on the workspace's summary row", async () => {
    const { wsId, spaceId } = await freshWorkspace('Admin Flag WS');
    for (let i = 1; i <= 5; i++) {
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `DB ${i}` });
    }
    await waitForSalesSignal(wsId);

    const { AdminOverviewService } = await import('../src/admin/admin-overview.service');
    const overview = app.get(AdminOverviewService);
    const summaries = await overview.listWorkspaces();
    const row = summaries.find((s) => s.id === wsId);
    expect(row?.salesSignalReason).toBe('fifth_database');
    expect(row?.salesSignalSentAt).toBeInstanceOf(Date);
  });
});
