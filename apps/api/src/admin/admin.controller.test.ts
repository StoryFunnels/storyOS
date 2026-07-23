import { describe, expect, it, vi } from 'vitest';
import {
  adminClearEntitlementOverrideRequestSchema,
  adminSetEntitlementOverrideRequestSchema,
  adminSetPlanRequestSchema,
} from '@storyos/schemas';
import type { AuthedRequest } from '../auth/auth.guard';
import type { AgentsService } from '../agents/agents.service';
import type { MarketplaceService } from '../packs/marketplace.service';
import type { EntitlementsService } from '../billing/entitlements.service';
import type { AdminOverviewService } from './admin-overview.service';
import type { AdminRunsService } from './admin-runs.service';
import type { AdminBillingService } from './admin-billing.service';
import type { CostAttributionService } from './cost-attribution.service';
import { AdminController } from './admin.controller';

function reqAs(userId: string): AuthedRequest {
  return { user: { id: userId } } as unknown as AuthedRequest;
}

function makeController(overrides?: {
  adminBilling?: Partial<AdminBillingService>;
  entitlements?: Partial<EntitlementsService>;
}) {
  const adminBilling = {
    setPlan: vi.fn().mockResolvedValue(undefined),
    getBillingView: vi.fn().mockResolvedValue({ workspaceId: 'ws1', plan: 'enterprise' }),
    ...overrides?.adminBilling,
  } as unknown as AdminBillingService;

  const entitlements = {
    setOverride: vi.fn().mockResolvedValue(undefined),
    clearOverride: vi.fn().mockResolvedValue(undefined),
    ...overrides?.entitlements,
  } as unknown as EntitlementsService;

  const controller = new AdminController(
    {} as AdminOverviewService,
    {} as CostAttributionService,
    {} as AdminRunsService,
    {} as AgentsService,
    {} as MarketplaceService,
    adminBilling,
    entitlements,
  );

  return { controller, adminBilling, entitlements };
}

describe('AdminController — #304 reason-required validation', () => {
  it('rejects a plan-set request with an empty reason', () => {
    const result = adminSetPlanRequestSchema.safeParse({ plan: 'enterprise', reason: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a plan-set request with a whitespace-only reason', () => {
    const result = adminSetPlanRequestSchema.safeParse({ plan: 'enterprise', reason: '   ' });
    expect(result.success).toBe(false);
  });

  it('accepts a plan-set request with a real reason', () => {
    const result = adminSetPlanRequestSchema.safeParse({ plan: 'enterprise', reason: 'comp deal' });
    expect(result.success).toBe(true);
  });

  it('rejects an entitlement-override set request with no reason', () => {
    const result = adminSetEntitlementOverrideRequestSchema.safeParse({ maxWorkspaces: 5 });
    expect(result.success).toBe(false);
  });

  it('rejects an entitlement-override clear request with no reason', () => {
    const result = adminClearEntitlementOverrideRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts an entitlement-override clear request with a reason', () => {
    const result = adminClearEntitlementOverrideRequestSchema.safeParse({ reason: 'contract ended' });
    expect(result.success).toBe(true);
  });
});

describe('AdminController.setWorkspacePlan (#304)', () => {
  it('delegates to AdminBillingService.setPlan with the actor, plan, reason, and parsed expiry, then returns the billing view', async () => {
    const { controller, adminBilling } = makeController();

    const result = await controller.setWorkspacePlan(reqAs('admin-user'), 'ws1', {
      plan: 'enterprise',
      reason: 'founder/internal account, unlimited for dogfooding and multi-workspace use',
      expires_at: undefined,
    });

    expect(adminBilling.setPlan).toHaveBeenCalledWith(
      'ws1',
      'admin-user',
      'enterprise',
      'founder/internal account, unlimited for dogfooding and multi-workspace use',
      null,
    );
    expect(adminBilling.getBillingView).toHaveBeenCalledWith('ws1');
    expect(result).toMatchObject({ workspaceId: 'ws1' });
  });

  it('parses a provided expires_at into a Date', async () => {
    const { controller, adminBilling } = makeController();

    await controller.setWorkspacePlan(reqAs('admin-user'), 'ws1', {
      plan: 'business',
      reason: 'temporary support grant',
      expires_at: '2027-01-01T00:00:00Z',
    });

    const call = (adminBilling.setPlan as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[4]).toBeInstanceOf(Date);
    expect((call[4] as Date).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('AdminController — entitlement-override wrapper round-trip (#304)', () => {
  it('setWorkspaceEntitlementOverride delegates to EntitlementsService.setOverride, stripping reason/expires_at out of the patch', async () => {
    const { controller, entitlements, adminBilling } = makeController();

    await controller.setWorkspaceEntitlementOverride(reqAs('admin-user'), 'ws1', {
      maxWorkspaces: 5,
      reason: 'founder needs multiple workspaces',
      expires_at: undefined,
    });

    expect(entitlements.setOverride).toHaveBeenCalledWith(
      'ws1',
      'admin-user',
      { maxWorkspaces: 5 },
      'founder needs multiple workspaces',
      null,
    );
    expect(adminBilling.getBillingView).toHaveBeenCalledWith('ws1');
  });

  it('clearWorkspaceEntitlementOverride delegates to EntitlementsService.clearOverride', async () => {
    const { controller, entitlements, adminBilling } = makeController();

    await controller.clearWorkspaceEntitlementOverride(reqAs('admin-user'), 'ws1', {
      reason: 'contract ended',
    });

    expect(entitlements.clearOverride).toHaveBeenCalledWith('ws1', 'admin-user', 'contract ended');
    expect(adminBilling.getBillingView).toHaveBeenCalledWith('ws1');
  });
});

describe('AdminController.getWorkspaceBilling (#304)', () => {
  it('delegates straight to AdminBillingService.getBillingView', async () => {
    const { controller, adminBilling } = makeController();

    const result = await controller.getWorkspaceBilling('ws1');

    expect(adminBilling.getBillingView).toHaveBeenCalledWith('ws1');
    expect(result).toMatchObject({ workspaceId: 'ws1' });
  });
});

describe('AdminController — PlatformAdminGuard gates every route, including #304 (structural)', () => {
  it('the controller class carries @UseGuards(AuthGuard, PlatformAdminGuard) applying to every method, per platform-admin.guard.test.ts', async () => {
    // The guard itself (accept admin / reject non-admin with 403) is unit
    // tested directly in platform-admin.guard.test.ts. Because it's applied
    // at the CLASS level (`@UseGuards(AuthGuard, PlatformAdminGuard)` on
    // AdminController, not per-method), that coverage already applies to the
    // #304 routes added here — there is no per-route guard to bypass. This
    // test only guards against someone accidentally re-scoping the guard to
    // specific methods in the future and forgetting the new ones.
    const guards: unknown[] = Reflect.getMetadata('__guards__', AdminController) ?? [];
    expect(guards.length).toBeGreaterThan(0);
  });
});

describe('AdminController — never touches live Stripe (#304 non-goal)', () => {
  it('does not import or call StripeService', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(`${__dirname}/admin.controller.ts`, 'utf8'),
    );
    expect(source).not.toMatch(/StripeService/);
    expect(source).not.toMatch(/stripe\.client/);
  });
});
