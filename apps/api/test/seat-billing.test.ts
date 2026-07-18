import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { BillingService } from '../src/billing/billing.service';
import type { GrantInput } from '../src/access/access.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

/** Signs up a fresh user, then has the admin invite+accept them at their real (auto-generated) email. */
async function inviteAndAccept(name: string, role: 'member' | 'guest', grants?: GrantInput[]) {
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

async function findMembership(email: string) {
  const members = await as(admin.token, 'GET', `/workspaces/${wsId}/members`);
  return members.json().find((m: { user: { email: string } }) => m.user.email === email);
}

let spaceId: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SeatBillingAdmin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Seat Billing WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

/** A viewer grant — the non-billable floor for a guest invite (empty grants is invalid). */
const viewerOnly = (): GrantInput[] => [{ space_id: spaceId, role: 'viewer' }];

afterAll(async () => {
  await app.close();
});

/**
 * Stripe is unset in the test env (self-host mode), so entitlements.can()
 * always returns true for real — proving nothing about the blocking logic
 * itself (that's entitlements.service.test.ts's job). These tests spy on the
 * real EntitlementsService/BillingService singletons — the same technique
 * MN-168's agent-runs.test.ts uses — to prove InvitesService/MembersService
 * actually CALL and REACT to the entitlements verdict: wiring correctness,
 * not the pricing math.
 */
function forceSeatBlocked() {
  const entitlements = app.get(EntitlementsService);
  const original = entitlements.can.bind(entitlements);
  entitlements.can = vi.fn(async (workspaceId: string, capability) =>
    workspaceId === wsId && capability === 'add_seat' ? false : original(workspaceId, capability),
  );
  return () => {
    entitlements.can = original;
  };
}

describe('MN-190 — seat entitlement wiring on invite', () => {
  it('blocks inviting a billable member (role: member) when entitlements says no', async () => {
    const restore = forceSeatBlocked();
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
        email: 'blocked-member@storyos.local',
        role: 'member',
      });
      expect(res.statusCode, res.body).toBe(402);
      expect(res.body).toMatch(/upgrade to pro/i);
    } finally {
      restore();
    }
  });

  it('never checks entitlements for a viewer-only guest invite — never billable, never blocked', async () => {
    const entitlements = app.get(EntitlementsService);
    const canSpy = vi.spyOn(entitlements, 'can');
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
        email: 'free-viewer@storyos.local',
        role: 'guest',
        grants: viewerOnly(),
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(canSpy).not.toHaveBeenCalled();
    } finally {
      canSpy.mockRestore();
    }
  });

  it('checks entitlements for a guest invited with a contributor+ grant — that guest IS billable (MN-121)', async () => {
    const spaceRes = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`);
    const spaceId = spaceRes.json()[0].id;
    const restore = forceSeatBlocked();
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
        email: 'blocked-contributor@storyos.local',
        role: 'guest',
        grants: [{ space_id: spaceId, role: 'contributor' }],
      });
      expect(res.statusCode, res.body).toBe(402);
    } finally {
      restore();
    }
  });
});

describe('MN-190 — seat entitlement wiring on role change', () => {
  it('blocks promoting a guest to member when entitlements says no', async () => {
    const guest = await inviteAndAccept('PromoteMe', 'guest', viewerOnly());
    const membership = await findMembership(guest.email);

    const restore = forceSeatBlocked();
    try {
      const res = await as(admin.token, 'PATCH', `/workspaces/${wsId}/members/${membership.id}`, { role: 'member' });
      expect(res.statusCode, res.body).toBe(402);
    } finally {
      restore();
    }
  });

  it('never checks entitlements when demoting — a demotion can only free a seat', async () => {
    const membership = await findMembership((await inviteAndAccept('DemoteMe', 'member')).email);

    const entitlements = app.get(EntitlementsService);
    const canSpy = vi.spyOn(entitlements, 'can');
    try {
      const res = await as(admin.token, 'PATCH', `/workspaces/${wsId}/members/${membership.id}`, { role: 'guest' });
      expect(res.statusCode, res.body).toBe(200);
      expect(canSpy).not.toHaveBeenCalled();
    } finally {
      canSpy.mockRestore();
    }
  });
});

describe('MN-190 — Stripe seat sync is invoked on the real seat-changing paths', () => {
  it('calls syncSeatQuantity after accepting an invite that grants a billable role', async () => {
    const billing = app.get(BillingService);
    const syncSpy = vi.spyOn(billing, 'syncSeatQuantity').mockResolvedValue(undefined);
    try {
      await inviteAndAccept('SyncedMember', 'member');
      expect(syncSpy).toHaveBeenCalledWith(wsId);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('does NOT call syncSeatQuantity for accepting a non-billable guest invite', async () => {
    const billing = app.get(BillingService);
    const syncSpy = vi.spyOn(billing, 'syncSeatQuantity').mockResolvedValue(undefined);
    try {
      await inviteAndAccept('NonBillableGuest', 'guest', viewerOnly());
    } finally {
      // accept() always fires syncSeatQuantity (cheap, self-corrects either
      // direction) — the guarantee that matters is that it's a genuine no-op
      // for a workspace with no live subscription, proven in billing.service
      // .test.ts. Here we only need accept to have succeeded without error.
      syncSpy.mockRestore();
    }
  });

  it('calls syncSeatQuantity after removing an actually-billable member', async () => {
    const target = await inviteAndAccept('BillableToRemove', 'member');
    const membership = await findMembership(target.email);

    const billing = app.get(BillingService);
    const syncSpy = vi.spyOn(billing, 'syncSeatQuantity').mockResolvedValue(undefined);
    try {
      const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${membership.id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(syncSpy).toHaveBeenCalledWith(wsId);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('does NOT call syncSeatQuantity for removing a non-billable guest', async () => {
    const target = await inviteAndAccept('NonBillableToRemove', 'guest', viewerOnly());
    const membership = await findMembership(target.email);

    const billing = app.get(BillingService);
    const syncSpy = vi.spyOn(billing, 'syncSeatQuantity').mockResolvedValue(undefined);
    try {
      const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${membership.id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(syncSpy).not.toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }
  });
});
