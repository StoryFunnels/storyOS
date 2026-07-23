import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { EntitlementsService } from '../billing/entitlements.service';
import { AdminBillingService } from './admin-billing.service';

/** A fake Db exercising only the exact chains AdminBillingService uses. */
function makeDb(opts: {
  workspaceExists?: boolean;
  existingSubscription?: Record<string, unknown> | undefined;
  auditEvents?: Record<string, unknown>[];
}) {
  const upserts: Record<string, unknown>[] = [];
  const auditInserts: Record<string, unknown>[] = [];

  const db = {
    query: {
      workspaces: {
        findFirst: vi.fn().mockResolvedValue(
          opts.workspaceExists === false ? undefined : { id: 'ws1', name: 'Acme' },
        ),
      },
      billingSubscriptions: {
        findFirst: vi.fn().mockResolvedValue(opts.existingSubscription),
      },
      entitlementOverrideEvents: {
        findMany: vi.fn().mockResolvedValue(opts.auditEvents ?? []),
      },
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (_table: unknown) => ({
          values(v: Record<string, unknown>) {
            // Distinguish the two inserts inside the transaction by shape:
            // the subscription upsert always carries `plan`; the audit event
            // always carries `action`.
            if ('action' in v) {
              auditInserts.push(v);
              return Promise.resolve();
            }
            return {
              onConflictDoUpdate(args: { set: Record<string, unknown> }) {
                upserts.push({ ...v, ...args.set });
                return Promise.resolve();
              },
            };
          },
        }),
      };
      return cb(tx);
    },
  } as unknown as Db;

  return { db, upserts, auditInserts };
}

function entitlementsStub(override?: Record<string, unknown> | undefined): EntitlementsService {
  return {
    getOverride: vi.fn().mockResolvedValue(override),
  } as unknown as EntitlementsService;
}

describe('AdminBillingService.setPlan (#304)', () => {
  it('upserts the plan and always nulls stripeSubscriptionId/status, even over an existing Stripe-backed row', async () => {
    const { db, upserts } = makeDb({
      existingSubscription: {
        workspaceId: 'ws1',
        plan: 'pro',
        status: 'active',
        stripeSubscriptionId: 'sub_real123',
        seats: 3,
      },
    });
    const svc = new AdminBillingService(db, entitlementsStub());

    await svc.setPlan('ws1', 'admin-user', 'enterprise', 'founder/internal account', null);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      workspaceId: 'ws1',
      plan: 'enterprise',
      status: null,
      stripeSubscriptionId: null,
    });
  });

  it('is idempotent — setting the same plan twice writes two upserts with the same terminal values, no error', async () => {
    const { db, upserts } = makeDb({ existingSubscription: undefined });
    const svc = new AdminBillingService(db, entitlementsStub());

    await svc.setPlan('ws1', 'admin-user', 'business', 'comp', null);
    await svc.setPlan('ws1', 'admin-user', 'business', 'comp (re-applied)', null);

    expect(upserts).toHaveLength(2);
    for (const row of upserts) {
      expect(row).toMatchObject({ workspaceId: 'ws1', plan: 'business', status: null, stripeSubscriptionId: null });
    }
  });

  it('writes an audit event (reusing entitlement_override_events, no parallel mechanism) with actor, reason, and the plan-change snapshot', async () => {
    const { db, auditInserts } = makeDb({});
    const svc = new AdminBillingService(db, entitlementsStub());

    const expiresAt = new Date('2027-01-01T00:00:00Z');
    await svc.setPlan('ws1', 'admin-user', 'enterprise', 'negotiated comp deal', expiresAt);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      workspaceId: 'ws1',
      actorUserId: 'admin-user',
      action: 'set',
      reason: 'negotiated comp deal',
      expiresAt,
    });
    expect(auditInserts[0]?.snapshot).toMatchObject({ kind: 'plan_change', plan: 'enterprise' });
  });

  it('throws NotFoundException for a workspace that does not exist', async () => {
    const { db } = makeDb({ workspaceExists: false });
    const svc = new AdminBillingService(db, entitlementsStub());

    await expect(svc.setPlan('missing-ws', 'admin-user', 'pro', 'reason', null)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('AdminBillingService.getBillingView (#304)', () => {
  it('defaults to the free plan and no override when nothing has ever been set', async () => {
    const { db } = makeDb({ existingSubscription: undefined });
    const svc = new AdminBillingService(db, entitlementsStub(undefined));

    const view = await svc.getBillingView('ws1');

    expect(view.plan).toBe('free');
    expect(view.status).toBeNull();
    expect(view.stripeSubscriptionId).toBeNull();
    expect(view.override).toBeNull();
    expect(view.auditTrail).toEqual([]);
  });

  it('projects the current plan, the active override, and the audit trail together', async () => {
    const overrideRow = {
      includedSeats: 50,
      automationRunsPerMonth: null,
      maxWorkspaces: 5,
      featureFlags: { sso: true },
      reason: 'negotiated Enterprise contract',
      expiresAt: null,
      createdBy: 'admin-user',
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const auditRow = {
      id: 'evt1',
      workspaceId: 'ws1',
      actorUserId: 'admin-user',
      action: 'set' as const,
      snapshot: { includedSeats: 50 },
      reason: 'negotiated Enterprise contract',
      expiresAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    const { db } = makeDb({
      existingSubscription: {
        plan: 'enterprise',
        status: null,
        stripeSubscriptionId: null,
        seats: 0,
        currentPeriodEnd: null,
      },
      auditEvents: [auditRow],
    });
    const svc = new AdminBillingService(db, entitlementsStub(overrideRow));

    const view = await svc.getBillingView('ws1');

    expect(view.plan).toBe('enterprise');
    expect(view.override).toMatchObject({ includedSeats: 50, maxWorkspaces: 5, createdBy: 'admin-user' });
    expect(view.auditTrail).toHaveLength(1);
    expect(view.auditTrail[0]).toMatchObject({ id: 'evt1', action: 'set', actorUserId: 'admin-user' });
  });

  it('throws NotFoundException for a workspace that does not exist', async () => {
    const { db } = makeDb({ workspaceExists: false });
    const svc = new AdminBillingService(db, entitlementsStub());

    await expect(svc.getBillingView('missing-ws')).rejects.toThrow(NotFoundException);
  });
});

describe('AdminBillingService — never touches live Stripe (#304 non-goal)', () => {
  it('does not depend on StripeService at all', async () => {
    // Structural guarantee, not just a runtime check: if StripeService were
    // ever injected here, this import would need updating — the absence of
    // any Stripe import/usage is the actual guarantee the ticket asks for.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(`${__dirname}/admin-billing.service.ts`, 'utf8'),
    );
    expect(source).not.toMatch(/StripeService/);
    expect(source).not.toMatch(/stripe\.client/);
  });
});
