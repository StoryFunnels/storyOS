import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { StripeService } from './stripe.service';
import { AiCreditsService } from './ai-credits.service';
import { AI_CREDIT_MIN_TOPUP_USD } from './plans';

/** A fake Db capturing balance upserts and ledger inserts. */
function makeDb(opts: {
  balanceRow?: { balanceCents: number; autoReloadEnabled?: boolean; autoReloadThresholdCents?: number | null; autoReloadAmountCents?: number | null };
  customerRow?: { stripeCustomerId: string };
  ledgerClaim?: Array<{ id: string }>;
}) {
  const balanceUpserts: Record<string, unknown>[] = [];
  const ledgerInserts: Record<string, unknown>[] = [];
  const ledgerClaim = opts.ledgerClaim ?? [{ id: 'txn_1' }];
  const db = {
    query: {
      aiCreditBalances: { findFirst: vi.fn().mockResolvedValue(opts.balanceRow) },
      billingCustomers: { findFirst: vi.fn().mockResolvedValue(opts.customerRow) },
      workspaces: { findFirst: vi.fn().mockResolvedValue({ id: 'ws1', name: 'W', slug: 'w' }) },
    },
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          if (v['type']) ledgerInserts.push(v); // usage/top_up rows are tagged with `type`; balance rows never are
          return this;
        },
        // Only applyTopUp's ledger insert chains onConflictDoNothing().returning() —
        // recordUsage's plain `await ...values(...)` resolves this object itself
        // (a non-Promise await is a no-op), and onConflictDoUpdate is the balance path.
        onConflictDoNothing() {
          return { returning: async () => ledgerClaim };
        },
        onConflictDoUpdate() {
          balanceUpserts.push(vals);
          return Promise.resolve();
        },
      };
    },
    transaction: async (fn: (tx: Db) => Promise<void>) => fn(db),
  } as unknown as Db;
  return { db, balanceUpserts, ledgerInserts };
}

function stripeStub(enabled: boolean, overrides: Record<string, unknown> = {}): StripeService {
  return { enabled, client: {} as never, ...overrides } as unknown as StripeService;
}

describe('AiCreditsService.getBalance', () => {
  it('returns zero for a workspace that never topped up', async () => {
    const { db } = makeDb({ balanceRow: undefined });
    const svc = new AiCreditsService(db, stripeStub(true));
    const balance = await svc.getBalance('ws1');
    expect(balance).toEqual({
      balanceCents: 0,
      autoReloadEnabled: false,
      autoReloadThresholdCents: null,
      autoReloadAmountCents: null,
    });
  });
});

describe('AiCreditsService.canUseManagedAi — the hard stop', () => {
  it('self-host: always false — the add-on is not a self-host thing at all', async () => {
    const { db } = makeDb({ balanceRow: { balanceCents: 1000 } });
    const svc = new AiCreditsService(db, stripeStub(false));
    expect(await svc.canUseManagedAi('ws1')).toBe(false);
  });

  it('blocks with a positive balance but no card on file', async () => {
    const { db } = makeDb({ balanceRow: { balanceCents: 1000 }, customerRow: undefined });
    const svc = new AiCreditsService(db, stripeStub(true));
    expect(await svc.canUseManagedAi('ws1')).toBe(false);
  });

  it('blocks at exactly zero balance, even with a card on file', async () => {
    const { db } = makeDb({
      balanceRow: { balanceCents: 0 },
      customerRow: { stripeCustomerId: 'cus_1' },
    });
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
      },
    });
    const svc = new AiCreditsService(db, stripe);
    expect(await svc.canUseManagedAi('ws1')).toBe(false);
  });

  it('allows when both a card is on file AND the balance is positive', async () => {
    const { db } = makeDb({
      balanceRow: { balanceCents: 500 },
      customerRow: { stripeCustomerId: 'cus_1' },
    });
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
      },
    });
    const svc = new AiCreditsService(db, stripe);
    expect(await svc.canUseManagedAi('ws1')).toBe(true);
  });
});

describe('AiCreditsService.recordUsage — never overdrafts', () => {
  it('debits the balance and writes a usage ledger row with cost attribution', async () => {
    const { db, balanceUpserts, ledgerInserts } = makeDb({ balanceRow: { balanceCents: 1000 } });
    const svc = new AiCreditsService(db, stripeStub(true));

    await svc.recordUsage('ws1', { tokensIn: 100, tokensOut: 50, ourCostCents: 2, creditsChargedCents: 20 });

    expect(balanceUpserts[0]).toMatchObject({ workspaceId: 'ws1', balanceCents: 980 });
    const usageRow = ledgerInserts.find((r) => r['type'] === 'usage');
    expect(usageRow).toMatchObject({ amountCents: -20, tokensIn: 100, tokensOut: 50, ourCostCents: 2 });
  });

  it('clamps at zero — a run costing more than the balance never goes negative', async () => {
    const { db, balanceUpserts } = makeDb({ balanceRow: { balanceCents: 10 } });
    const svc = new AiCreditsService(db, stripeStub(true));

    await svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 500 });

    expect(balanceUpserts[0]).toMatchObject({ balanceCents: 0 });
  });
});

describe('AiCreditsService.applyTopUp — idempotent via payment_intent', () => {
  it('credits the balance on first delivery', async () => {
    const { db, balanceUpserts, ledgerInserts } = makeDb({ balanceRow: { balanceCents: 0 } });
    const svc = new AiCreditsService(db, stripeStub(true));

    await svc.applyTopUp('ws1', 1000, 'pi_1');

    expect(ledgerInserts.some((r) => r['type'] === 'top_up' && r['stripePaymentIntentId'] === 'pi_1')).toBe(true);
    expect(balanceUpserts).toHaveLength(1);
  });

  it('no-ops on a duplicate webhook delivery for the same payment_intent', async () => {
    const { db, balanceUpserts } = makeDb({ balanceRow: { balanceCents: 500 }, ledgerClaim: [] });
    const svc = new AiCreditsService(db, stripeStub(true));

    await svc.applyTopUp('ws1', 1000, 'pi_1');

    expect(balanceUpserts).toHaveLength(0);
  });
});

describe('AiCreditsService.createTopUpSession — enforces the minimum', () => {
  it('rejects a top-up below the minimum', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true));
    await expect(svc.createTopUpSession('ws1', AI_CREDIT_MIN_TOPUP_USD - 1)).rejects.toThrow(/minimum top-up/i);
  });
});

describe('AiCreditsService.setAutoReload — validates before persisting', () => {
  it('rejects enabling auto-reload without both a threshold and an amount', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true));
    await expect(svc.setAutoReload('ws1', { enabled: true })).rejects.toThrow(/threshold/i);
  });

  it('rejects an auto-reload amount below the minimum top-up', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true));
    await expect(
      svc.setAutoReload('ws1', { enabled: true, thresholdCents: 500, amountCents: 100 }),
    ).rejects.toThrow(/at least/i);
  });

  it('accepts disabling auto-reload with no thresholds at all', async () => {
    const { db, balanceUpserts } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true));
    await svc.setAutoReload('ws1', { enabled: false });
    expect(balanceUpserts[0]).toMatchObject({ autoReloadEnabled: false });
  });
});
