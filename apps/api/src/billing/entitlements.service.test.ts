import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
import type { BillingService, BillingStatus } from './billing.service';
import type { StripeService } from './stripe.service';
import { EntitlementsService } from './entitlements.service';
import { PLANS } from './plans';

/** A fake Db that captures usage_counters upserts. Only the exact chain used. */
function makeDb(opts: { existingCount?: number }) {
  const upserts: Record<string, unknown>[] = [];
  const db = {
    query: {
      usageCounters: {
        findFirst: vi.fn().mockResolvedValue(
          opts.existingCount === undefined ? undefined : { count: opts.existingCount },
        ),
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
  } as unknown as Db;
  return { db, upserts };
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
