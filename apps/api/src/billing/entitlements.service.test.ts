import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
import type { BillingService, BillingStatus } from './billing.service';
import type { StripeService } from './stripe.service';
import { EntitlementsService } from './entitlements.service';
import { PLANS } from './plans';

/** A fake Db that captures usage_counters upserts. Only the exact chain used. */
function makeDb(opts: {
  existingCount?: number;
  ownedWorkspaces?: unknown[];
  override?: Record<string, unknown> | null;
  overridesByWorkspace?: Record<string, unknown>[];
}) {
  const upserts: Record<string, unknown>[] = [];
  const overrideWrites: { action: 'upsert' | 'delete'; values: Record<string, unknown> }[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const db = {
    query: {
      usageCounters: {
        findFirst: vi.fn().mockResolvedValue(
          opts.existingCount === undefined ? undefined : { count: opts.existingCount },
        ),
      },
      memberships: {
        findMany: vi.fn().mockResolvedValue(opts.ownedWorkspaces ?? []),
      },
      workspaceEntitlementOverrides: {
        findFirst: vi.fn().mockResolvedValue(opts.override ?? undefined),
        findMany: vi.fn().mockResolvedValue(opts.overridesByWorkspace ?? []),
      },
    },
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          return this;
        },
        onConflictDoUpdate() {
          upserts.push(vals);
          return Promise.resolve();
        },
      };
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: () => {
          let vals: Record<string, unknown> = {};
          return {
            values(v: Record<string, unknown>) {
              vals = v;
              return this;
            },
            onConflictDoUpdate() {
              overrideWrites.push({ action: 'upsert', values: vals });
              return { returning: async () => [vals] };
            },
            then(resolve: (v: unknown) => unknown) {
              // plain `await tx.insert(...).values(...)` for the audit event
              auditEvents.push(vals);
              return resolve(undefined);
            },
          };
        },
        delete: () => ({
          where() {
            return {
              returning: async () =>
                opts.override === null || opts.override === undefined ? [] : [opts.override],
            };
          },
        }),
      };
      return cb(tx);
    },
  } as unknown as Db;
  return { db, upserts, overrideWrites, auditEvents };
}

function stripeStub(enabled: boolean): StripeService {
  return { enabled } as unknown as StripeService;
}

function billingStub(plan: BillingStatus['plan']): BillingService {
  return {
    getStatus: vi.fn().mockResolvedValue({
      plan,
      status: 'active',
      seats: 0,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      trialEndsAt: null,
    }),
  } as unknown as BillingService;
}

function accessStub(billableUserIds: string[]): AccessService {
  return { billableUserIds: vi.fn().mockResolvedValue(billableUserIds) } as unknown as AccessService;
}

describe('EntitlementsService.getLimits', () => {
  it('returns the plan catalogue limits when billing is enabled', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    const limits = await svc.getLimits('ws1');

    expect(limits).toEqual({ automationRunsPerMonth: 1000, includedSeats: 3 });
  });

  it('returns unlimited without touching billing when Stripe is disabled (self-host)', async () => {
    const { db } = makeDb({});
    const billing = billingStub('free');
    const svc = new EntitlementsService(db, stripeStub(false), billing, accessStub([]));

    const limits = await svc.getLimits('ws1');

    expect(limits.automationRunsPerMonth).toBe(Infinity);
    expect(limits.includedSeats).toBe(Infinity);
    expect(billing.getStatus).not.toHaveBeenCalled();
  });
});

describe('EntitlementsService.getLimits — MN-196 entitlement overrides', () => {
  it('an active override wins over the plan default, field by field', async () => {
    const { db } = makeDb({
      override: { includedSeats: 50, automationRunsPerMonth: null, expiresAt: null },
    });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    const limits = await svc.getLimits('ws1');

    expect(limits.includedSeats).toBe(50); // overridden
    expect(limits.automationRunsPerMonth).toBe(1000); // null override field falls through to plan
  });

  it('an expired override is ignored — falls back to plan defaults', async () => {
    const { db } = makeDb({
      override: { includedSeats: 999, automationRunsPerMonth: 999, expiresAt: new Date(Date.now() - 1000) },
    });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    const limits = await svc.getLimits('ws1');

    expect(limits).toEqual({ automationRunsPerMonth: 1000, includedSeats: 3 });
  });

  it('a future expiry still applies', async () => {
    const { db } = makeDb({
      override: { includedSeats: 50, automationRunsPerMonth: null, expiresAt: new Date(Date.now() + 1_000_000) },
    });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    expect((await svc.getLimits('ws1')).includedSeats).toBe(50);
  });

  it('no override row at all — plan defaults apply, no crash', async () => {
    const { db } = makeDb({ override: undefined });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));

    expect(await svc.getLimits('ws1')).toEqual({ automationRunsPerMonth: 100, includedSeats: 2 });
  });

  it('fixes the Enterprise zero-seat placeholder — unlimited by default until overridden', async () => {
    const { db } = makeDb({ override: undefined });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('enterprise'), accessStub([]));

    const limits = await svc.getLimits('ws1');

    expect(limits.includedSeats).toBe(Infinity);
    expect(limits.automationRunsPerMonth).toBe(Infinity);
  });
});

describe('EntitlementsService.setOverride / clearOverride (MN-196)', () => {
  it('setOverride upserts the row and writes a "set" audit event', async () => {
    const { db, overrideWrites, auditEvents } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('enterprise'), accessStub([]));

    const expiresAt = new Date('2027-01-01T00:00:00Z');
    await svc.setOverride('ws1', 'admin-user', { includedSeats: 25 }, 'negotiated Enterprise contract', expiresAt);

    expect(overrideWrites).toHaveLength(1);
    expect(overrideWrites[0]?.values).toMatchObject({
      workspaceId: 'ws1',
      includedSeats: 25,
      reason: 'negotiated Enterprise contract',
      createdBy: 'admin-user',
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      workspaceId: 'ws1',
      actorUserId: 'admin-user',
      action: 'set',
      reason: 'negotiated Enterprise contract',
    });
  });

  it('clearOverride deletes the row and writes a "clear" audit event with the prior snapshot', async () => {
    const priorRow = { workspaceId: 'ws1', includedSeats: 25, reason: 'old reason' };
    const { db, auditEvents } = makeDb({ override: priorRow });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('enterprise'), accessStub([]));

    await svc.clearOverride('ws1', 'admin-user', 'contract ended');

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      workspaceId: 'ws1',
      actorUserId: 'admin-user',
      action: 'clear',
      reason: 'contract ended',
      snapshot: priorRow,
    });
  });

  it('clearOverride on a workspace with no override is a no-op — no audit event written', async () => {
    const { db, auditEvents } = makeDb({ override: null });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));

    await svc.clearOverride('ws1', 'admin-user', 'nothing to clear');

    expect(auditEvents).toHaveLength(0);
  });
});

describe('EntitlementsService.getUsage', () => {
  it('reads seats live even when billing is disabled', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(false), billingStub('free'), accessStub(['u1', 'u2']));

    const usage = await svc.getUsage('ws1');

    expect(usage.billableSeats).toBe(2);
    expect(usage.automationRunsThisMonth).toBe(0);
  });

  it('reads the current-month counter when billing is enabled', async () => {
    const { db } = makeDb({ existingCount: 42 });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    const usage = await svc.getUsage('ws1');

    expect(usage.automationRunsThisMonth).toBe(42);
  });
});

describe('EntitlementsService.can', () => {
  it('self-host: always true, never queries usage or limits', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(false), billingStub('free'), accessStub([]));

    expect(await svc.can('ws1', 'automation_run')).toBe(true);
    expect(db.query.usageCounters.findFirst).not.toHaveBeenCalled();
  });

  it('allows a run strictly under the allowance', async () => {
    const { db } = makeDb({ existingCount: 99 });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));

    expect(await svc.can('ws1', 'automation_run')).toBe(true); // Free = 100/mo
  });

  it('blocks once usage reaches the allowance', async () => {
    const { db } = makeDb({ existingCount: 100 });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));

    expect(await svc.can('ws1', 'automation_run')).toBe(false);
  });
});

describe('EntitlementsService.can — add_seat (MN-190)', () => {
  it('Free: allows a 2nd billable member (at, not over, the included tier)', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub(['owner']));
    expect(await svc.can('ws1', 'add_seat')).toBe(true); // 1 billable < 2 included
  });

  it('Free: blocks a 3rd billable member — the only real seat ceiling in the system', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub(['a', 'b']));
    expect(await svc.can('ws1', 'add_seat')).toBe(false); // 2 billable == 2 included
  });

  it('Pro: always allows another seat — no ceiling, just +$12/mo', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub(['a', 'b', 'c', 'd', 'e']));
    expect(await svc.can('ws1', 'add_seat')).toBe(true);
  });

  it('Business: always allows another seat', async () => {
    const { db } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('business'), accessStub(['a', 'b', 'c', 'd', 'e', 'f']));
    expect(await svc.can('ws1', 'add_seat')).toBe(true);
  });

  it('self-host: always true, never reads billing status', async () => {
    const { db } = makeDb({});
    const billing = billingStub('free');
    const svc = new EntitlementsService(db, stripeStub(false), billing, accessStub(['a', 'b']));
    expect(await svc.can('ws1', 'add_seat')).toBe(true);
    expect(billing.getStatus).not.toHaveBeenCalled();
  });
});

describe('EntitlementsService.canCreateWorkspace (MN-191)', () => {
  it('allows the first workspace — a brand new admin owns none yet', async () => {
    const { db } = makeDb({ ownedWorkspaces: [] });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));
    expect(await svc.canCreateWorkspace('user1')).toBe(true);
  });

  it('blocks a 2nd workspace — multi-workspace is Enterprise-only, no plan unlocks it self-serve', async () => {
    const { db } = makeDb({ ownedWorkspaces: [{ workspaceId: 'ws1' }] });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('free'), accessStub([]));
    expect(await svc.canCreateWorkspace('user1')).toBe(false);
  });

  it('self-host: unlimited, never queries memberships', async () => {
    const { db } = makeDb({ ownedWorkspaces: [{ workspaceId: 'ws1' }] });
    const svc = new EntitlementsService(db, stripeStub(false), billingStub('free'), accessStub([]));
    expect(await svc.canCreateWorkspace('user1')).toBe(true);
    expect(db.query.memberships.findMany).not.toHaveBeenCalled();
  });
});

describe('EntitlementsService.canCreateWorkspace — MN-196 maxWorkspaces override', () => {
  it('a maxWorkspaces override on an owned workspace raises the cap past the flat self-serve limit', async () => {
    const { db } = makeDb({
      ownedWorkspaces: [{ workspaceId: 'ws1' }],
      overridesByWorkspace: [{ workspaceId: 'ws1', maxWorkspaces: 5, expiresAt: null }],
    });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('enterprise'), accessStub([]));

    expect(await svc.canCreateWorkspace('user1')).toBe(true); // 1 owned < 5
  });

  it('an expired maxWorkspaces override does not count — falls back to the flat cap', async () => {
    const { db } = makeDb({
      ownedWorkspaces: [{ workspaceId: 'ws1' }],
      overridesByWorkspace: [
        { workspaceId: 'ws1', maxWorkspaces: 5, expiresAt: new Date(Date.now() - 1000) },
      ],
    });
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('enterprise'), accessStub([]));

    expect(await svc.canCreateWorkspace('user1')).toBe(false); // 1 owned, flat cap is 1
  });
});

describe('EntitlementsService.recordNonAiRun', () => {
  it('self-host: never writes to usage_counters (no phone-home)', async () => {
    const { db, upserts } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(false), billingStub('free'), accessStub([]));

    await svc.recordNonAiRun('ws1');

    expect(upserts).toHaveLength(0);
  });

  it('upserts an increment when billing is enabled', async () => {
    const { db, upserts } = makeDb({});
    const svc = new EntitlementsService(db, stripeStub(true), billingStub('pro'), accessStub([]));

    await svc.recordNonAiRun('ws1');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ workspaceId: 'ws1', metric: 'automation_runs', count: 1 });
  });
});

describe('MN-168 structural guarantees', () => {
  it('no plan carries a record-limit or storage-limit key — unlimited records is load-bearing', () => {
    for (const plan of Object.values(PLANS)) {
      const keys = Object.keys(plan);
      expect(keys).not.toContain('maxRecords');
      expect(keys).not.toContain('recordLimit');
      expect(keys).not.toContain('storageBytes');
      expect(keys).not.toContain('storageLimit');
    }
  });
});
