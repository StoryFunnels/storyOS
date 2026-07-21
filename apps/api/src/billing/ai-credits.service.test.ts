import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { StripeService } from './stripe.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { EmailService } from '../mail/email.service';
import { AiCreditsService } from './ai-credits.service';
import { AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES, AI_CREDIT_MIN_TOPUP_USD, creditExpiryDate } from './plans';

const pgDialect = new PgDialect();

/** A fake Db capturing balance upserts and ledger inserts. */
function makeDb(opts: {
  balanceRow?: {
    balanceCents: number;
    autoReloadEnabled?: boolean;
    autoReloadThresholdCents?: number | null;
    autoReloadAmountCents?: number | null;
  };
  customerRow?: { stripeCustomerId: string };
  ledgerClaim?: Array<{ id: string }>;
  /** Rows expireStaleCredits's lazy-expiry query sees (its WHERE references
   * `expires_at`) — empty by default. */
  staleTopUpRows?: Array<{ id: string; remainingCents: number | null }>;
  /** Rows consumeTopUpsFifo's FIFO-consumption query sees (its WHERE does
   * NOT reference `expires_at`) — empty by default, so existing debit-only
   * behavior is unaffected unless a test opts in. Must already be in the
   * order the real `ORDER BY created_at ASC` would produce. */
  liveTopUpRows?: Array<{ id: string; remainingCents: number | null; createdAt: Date }>;
}) {
  const balanceUpserts: Record<string, unknown>[] = [];
  const ledgerInserts: Record<string, unknown>[] = [];
  const transactionUpdates: Array<{ id?: unknown; vals: Record<string, unknown> }> = [];
  const ledgerClaim = opts.ledgerClaim ?? [{ id: 'txn_1' }];
  const db = {
    query: {
      aiCreditBalances: { findFirst: vi.fn().mockResolvedValue(opts.balanceRow) },
      aiCreditTransactions: {
        // Two distinct call sites share findMany (expireStaleCredits vs.
        // consumeTopUpsFifo) — distinguished by whether their WHERE clause
        // references expires_at, same technique
        // trial-reminders.service.test.ts uses to tell its two milestone
        // queries apart.
        findMany: vi.fn(async ({ where }: { where: SQL }) => {
          const sql = pgDialect.sqlToQuery(where).sql;
          return sql.includes('expires_at') ? (opts.staleTopUpRows ?? []) : (opts.liveTopUpRows ?? []);
        }),
      },
      billingCustomers: { findFirst: vi.fn().mockResolvedValue(opts.customerRow) },
      workspaces: { findFirst: vi.fn().mockResolvedValue({ id: 'ws1', name: 'W', slug: 'w' }) },
    },
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          if (v['type']) ledgerInserts.push(v); // usage/top_up/adjustment rows are tagged with `type`; balance rows never are
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
    // Only exercised by expireStaleCredits/consumeTopUpsFifo (zeroing/decrementing
    // a top-up row's remainingCents) in this shared fake — tryAutoReload's claim
    // mutex uses its own dedicated fake below, since it needs `.returning()`.
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          transactionUpdates.push({ vals });
          return Promise.resolve();
        },
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db),
  } as unknown as Db;
  return { db, balanceUpserts, ledgerInserts, transactionUpdates };
}

function stripeStub(enabled: boolean, overrides: Record<string, unknown> = {}): StripeService {
  return { enabled, client: {} as never, ...overrides } as unknown as StripeService;
}

function notificationsStub(overrides: Record<string, unknown> = {}): NotificationsService {
  return { notify: vi.fn().mockResolvedValue(undefined), ...overrides } as unknown as NotificationsService;
}

function emailStub(overrides: Record<string, unknown> = {}): EmailService {
  return { send: vi.fn().mockResolvedValue(undefined), ...overrides } as unknown as EmailService;
}

describe('AiCreditsService.getBalance', () => {
  it('returns zero for a workspace that never topped up', async () => {
    const { db } = makeDb({ balanceRow: undefined });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    const balance = await svc.getBalance('ws1');
    expect(balance).toEqual({
      balanceCents: 0,
      autoReloadEnabled: false,
      autoReloadThresholdCents: null,
      autoReloadAmountCents: null,
    });
  });

  it('forfeits an expired top-up\'s unused remainder (lazy expiry) before returning the balance', async () => {
    const { db, balanceUpserts, ledgerInserts } = makeDb({
      balanceRow: { balanceCents: 700 },
      staleTopUpRows: [{ id: 'txn_top_1', remainingCents: 300 }],
    });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    const balance = await svc.getBalance('ws1');

    // 700 balance minus the 300 still owed by the now-expired top-up.
    expect(balance.balanceCents).toBe(400);
    expect(balanceUpserts[0]).toMatchObject({ balanceCents: 400 });
    const adjustment = ledgerInserts.find((r) => r['type'] === 'adjustment');
    expect(adjustment).toMatchObject({ amountCents: -300 });
  });

  it('leaves the balance untouched when there is nothing stale to expire', async () => {
    const { db, balanceUpserts } = makeDb({ balanceRow: { balanceCents: 500 }, staleTopUpRows: [] });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    const balance = await svc.getBalance('ws1');

    expect(balance.balanceCents).toBe(500);
    expect(balanceUpserts).toHaveLength(0);
  });
});

describe('AiCreditsService.canUseManagedAi — the hard stop', () => {
  it('self-host: always false — the add-on is not a self-host thing at all', async () => {
    const { db } = makeDb({ balanceRow: { balanceCents: 1000 } });
    const svc = new AiCreditsService(db, stripeStub(false), notificationsStub(), emailStub());
    expect(await svc.canUseManagedAi('ws1')).toBe(false);
  });

  it('blocks with a positive balance but no card on file', async () => {
    const { db } = makeDb({ balanceRow: { balanceCents: 1000 }, customerRow: undefined });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
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
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());
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
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());
    expect(await svc.canUseManagedAi('ws1')).toBe(true);
  });
});

describe('AiCreditsService.recordUsage — never overdrafts', () => {
  it('debits the balance and writes a usage ledger row with cost attribution', async () => {
    const { db, balanceUpserts, ledgerInserts } = makeDb({ balanceRow: { balanceCents: 1000 } });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    await svc.recordUsage('ws1', { tokensIn: 100, tokensOut: 50, ourCostCents: 2, creditsChargedCents: 20 });

    expect(balanceUpserts[0]).toMatchObject({ workspaceId: 'ws1', balanceCents: 980 });
    const usageRow = ledgerInserts.find((r) => r['type'] === 'usage');
    expect(usageRow).toMatchObject({ amountCents: -20, tokensIn: 100, tokensOut: 50, ourCostCents: 2 });
  });

  it('clamps at zero — a run costing more than the balance never goes negative', async () => {
    const { db, balanceUpserts } = makeDb({ balanceRow: { balanceCents: 10 } });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    await svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 500 });

    expect(balanceUpserts[0]).toMatchObject({ balanceCents: 0 });
  });

  it('writes down the oldest live top-up\'s remainder FIFO by the amount actually consumed', async () => {
    const { db, transactionUpdates } = makeDb({
      balanceRow: { balanceCents: 1000 },
      liveTopUpRows: [
        { id: 'txn_old', remainingCents: 400, createdAt: new Date('2025-01-01') },
        { id: 'txn_new', remainingCents: 900, createdAt: new Date('2025-06-01') },
      ],
    });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    // Consumes 600 — more than the oldest top-up's 400 remainder, so it should
    // drain txn_old to 0 and take the other 200 from txn_new.
    await svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 600 });

    expect(transactionUpdates).toEqual([
      { vals: { remainingCents: 0 } }, // 400 - 400
      { vals: { remainingCents: 700 } }, // 900 - 200
    ]);
  });

  it('does not attempt a reload when auto-reload is disabled, even below any nominal threshold', async () => {
    const { db } = makeDb({
      balanceRow: { balanceCents: 100, autoReloadEnabled: false, autoReloadThresholdCents: 500, autoReloadAmountCents: 1000 },
    });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    const trySpy = vi.spyOn(svc, 'tryAutoReload');

    await svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 50 });

    expect(trySpy).not.toHaveBeenCalled();
  });

  it('fires tryAutoReload once the debit crosses the configured threshold', async () => {
    const { db } = makeDb({
      balanceRow: { balanceCents: 100, autoReloadEnabled: true, autoReloadThresholdCents: 50, autoReloadAmountCents: 1000 },
    });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    const trySpy = vi.spyOn(svc, 'tryAutoReload').mockResolvedValue('skipped');

    // 100 - 60 = 40, at/below the 50-cent threshold.
    await svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 60 });

    expect(trySpy).toHaveBeenCalledWith('ws1');
  });

  it('never lets a reload attempt throwing fail the calling run', async () => {
    const { db } = makeDb({
      balanceRow: { balanceCents: 100, autoReloadEnabled: true, autoReloadThresholdCents: 50, autoReloadAmountCents: 1000 },
    });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    vi.spyOn(svc, 'tryAutoReload').mockRejectedValue(new Error('boom'));

    await expect(
      svc.recordUsage('ws1', { tokensIn: 1, tokensOut: 1, ourCostCents: 1, creditsChargedCents: 60 }),
    ).resolves.toBeUndefined();
  });
});

describe('AiCreditsService.applyTopUp — idempotent via payment_intent', () => {
  it('credits the balance on first delivery, expiring 12 months out with the full remainder tracked', async () => {
    const { db, balanceUpserts, ledgerInserts } = makeDb({ balanceRow: { balanceCents: 0 } });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    const before = new Date();
    await svc.applyTopUp('ws1', 1000, 'pi_1');
    const after = new Date();

    const topUpRow = ledgerInserts.find((r) => r['type'] === 'top_up' && r['stripePaymentIntentId'] === 'pi_1');
    expect(topUpRow).toMatchObject({ remainingCents: 1000 });
    const expiresAt = topUpRow?.['expiresAt'] as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(creditExpiryDate(before).getTime());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(creditExpiryDate(after).getTime());
    expect(balanceUpserts).toHaveLength(1);
  });

  it('no-ops on a duplicate webhook delivery for the same payment_intent', async () => {
    const { db, balanceUpserts } = makeDb({ balanceRow: { balanceCents: 500 }, ledgerClaim: [] });
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());

    await svc.applyTopUp('ws1', 1000, 'pi_1');

    expect(balanceUpserts).toHaveLength(0);
  });
});

describe('AiCreditsService.createTopUpSession — enforces the minimum', () => {
  it('rejects a top-up below the minimum', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    await expect(svc.createTopUpSession('ws1', AI_CREDIT_MIN_TOPUP_USD - 1)).rejects.toThrow(/minimum top-up/i);
  });
});

describe('AiCreditsService.setAutoReload — validates before persisting', () => {
  it('rejects enabling auto-reload without both a threshold and an amount', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    await expect(svc.setAutoReload('ws1', { enabled: true })).rejects.toThrow(/threshold/i);
  });

  it('rejects an auto-reload amount below the minimum top-up', async () => {
    const { db } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    await expect(
      svc.setAutoReload('ws1', { enabled: true, thresholdCents: 500, amountCents: 100 }),
    ).rejects.toThrow(/at least/i);
  });

  it('accepts disabling auto-reload with no thresholds at all', async () => {
    const { db, balanceUpserts } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    await svc.setAutoReload('ws1', { enabled: false });
    expect(balanceUpserts[0]).toMatchObject({ autoReloadEnabled: false });
  });

  it('resets any stale failure count / backoff timer when re-enabling', async () => {
    const { db, balanceUpserts } = makeDb({});
    const svc = new AiCreditsService(db, stripeStub(true), notificationsStub(), emailStub());
    await svc.setAutoReload('ws1', { enabled: true, thresholdCents: 500, amountCents: 1000 });
    expect(balanceUpserts[0]).toMatchObject({ autoReloadFailureCount: 0, autoReloadNextRetryAt: null });
  });
});

/**
 * A dedicated fake for tryAutoReload — needs `.update(...).where(...).returning()`
 * for the atomic claim (see the real service's doc comment for why this
 * shape is the concurrency guard), which the debit-focused `makeDb` above
 * doesn't model. Mirrors trial-reminders.service.test.ts's own dedicated
 * fake for the exact same reason: reading which call is "the claim" off the
 * `.set()` payload's shape, not off call order, so it stays correct under
 * concurrent/overlapping calls.
 *
 * `claimResults` is a queue popped once per claim attempt (default: an
 * infinite supply of one successful claim) — a test simulates "a second
 * concurrent caller loses the race" by queuing `[[{...}], []]`.
 */
function makeAutoReloadDb(opts: {
  claimResults?: Array<Array<{ amountCents: number | null; failureCount: number }>>;
  customerRow?: { stripeCustomerId: string };
  workspace?: { id: string; name: string; slug: string };
  admins?: Array<{ userId: string }>;
  adminUsers?: Array<{ id: string; email: string }>;
}) {
  const claimQueue = opts.claimResults ?? [[{ amountCents: 1000, failureCount: 0 }]];
  let claimIdx = 0;
  const updateCalls: Record<string, unknown>[] = [];
  const balanceUpserts: Record<string, unknown>[] = [];
  const ledgerInserts: Record<string, unknown>[] = [];
  const ledgerClaim = [{ id: 'txn_reload' }];

  const db = {
    query: {
      billingCustomers: { findFirst: vi.fn().mockResolvedValue(opts.customerRow) },
      workspaces: { findFirst: vi.fn().mockResolvedValue(opts.workspace) },
      memberships: { findMany: vi.fn().mockResolvedValue(opts.admins ?? []) },
      user: { findMany: vi.fn().mockResolvedValue(opts.adminUsers ?? []) },
    },
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        updateCalls.push(vals);
        const isClaimAttempt = vals['autoReloadClaimedAt'] instanceof Date;
        return {
          where: () => ({
            returning: async () => {
              if (!isClaimAttempt) return [];
              const result = claimQueue[Math.min(claimIdx, claimQueue.length - 1)] ?? [];
              claimIdx++;
              return result;
            },
          }),
        };
      },
    }),
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          if (v['type']) ledgerInserts.push(v);
          return this;
        },
        onConflictDoNothing() {
          return { returning: async () => ledgerClaim };
        },
        onConflictDoUpdate() {
          balanceUpserts.push(vals);
          return Promise.resolve();
        },
      };
    },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db),
  } as unknown as Db;

  return { db, updateCalls, balanceUpserts, ledgerInserts };
}

const workspace = { id: 'ws1', name: 'Acme', slug: 'acme' };
const admins = [{ userId: 'u1' }];
const adminUsers = [{ id: 'u1', email: 'admin@acme.test' }];

describe('AiCreditsService.tryAutoReload — the off-session charge', () => {
  it('charges the saved card off-session and credits the balance on success', async () => {
    const { db, balanceUpserts, ledgerInserts, updateCalls } = makeAutoReloadDb({
      customerRow: { stripeCustomerId: 'cus_1' },
    });
    const create = vi.fn().mockResolvedValue({ id: 'pi_reload_1' });
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
        paymentIntents: { create },
      },
    });
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());

    const outcome = await svc.tryAutoReload('ws1');

    expect(outcome).toBe('succeeded');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        currency: 'usd',
        customer: 'cus_1',
        payment_method: 'pm_1',
        off_session: true,
        confirm: true,
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('ws1') }),
    );
    // applyTopUp's ledger row + balance credit actually landed.
    expect(ledgerInserts.some((r) => r['stripePaymentIntentId'] === 'pi_reload_1')).toBe(true);
    expect(balanceUpserts).toHaveLength(1);
    // Claim was released and the failure count reset.
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ autoReloadClaimedAt: null, autoReloadFailureCount: 0, autoReloadNextRetryAt: null }),
    );
  });

  it('concurrency: two calls racing the same claim only charge once', async () => {
    // Models two `recordUsage` calls crossing the threshold in the same
    // instant: both attempt the claim, but the atomic
    // `UPDATE ... WHERE auto_reload_claimed_at IS NULL` can only match the
    // row once — the second attempt's `.returning()` comes back empty.
    const { db } = makeAutoReloadDb({
      claimResults: [[{ amountCents: 1000, failureCount: 0 }], []],
      customerRow: { stripeCustomerId: 'cus_1' },
    });
    const create = vi.fn().mockResolvedValue({ id: 'pi_reload_1' });
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
        paymentIntents: { create },
      },
    });
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());

    const [first, second] = await Promise.all([svc.tryAutoReload('ws1'), svc.tryAutoReload('ws1')]);

    expect([first, second].sort()).toEqual(['skipped', 'succeeded']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('skips without calling Stripe when nothing wins the claim (already in flight / disabled / backing off)', async () => {
    const { db } = makeAutoReloadDb({ claimResults: [[]] });
    const create = vi.fn();
    const stripe = stripeStub(true, { client: { paymentIntents: { create } } });
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());

    expect(await svc.tryAutoReload('ws1')).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('a declined/SCA-required charge is retried with backoff, not immediately disabled', async () => {
    const { db, updateCalls } = makeAutoReloadDb({
      claimResults: [[{ amountCents: 1000, failureCount: 0 }]],
      customerRow: { stripeCustomerId: 'cus_1' },
      workspace,
      admins,
      adminUsers,
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
        paymentIntents: { create: vi.fn().mockRejectedValue(new Error('Your card was declined.')) },
      },
    });
    const svc = new AiCreditsService(db, stripe, notificationsStub({ notify }), emailStub({ send }));

    const before = Date.now();
    const outcome = await svc.tryAutoReload('ws1');

    expect(outcome).toBe('retrying');
    // Notified in-app about the failure...
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'auto_reload_failed' }));
    // ...but NOT emailed — a single transient decline shouldn't inbox-spam.
    expect(send).not.toHaveBeenCalled();
    const failureUpdate = updateCalls.find((c) => c['autoReloadFailureCount'] === 1);
    expect(failureUpdate).toMatchObject({ autoReloadClaimedAt: null, autoReloadFailureCount: 1 });
    const nextRetryAt = failureUpdate?.['autoReloadNextRetryAt'] as Date;
    expect(nextRetryAt.getTime()).toBeGreaterThanOrEqual(
      before + AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES[0] * 60_000 - 1000,
    );
  });

  it('disables auto-reload and emails once the failure count reaches the documented max attempts', async () => {
    const { db, updateCalls } = makeAutoReloadDb({
      // failureCount: 2 means this attempt is the 3rd consecutive failure —
      // the default AI_CREDIT_AUTO_RELOAD_MAX_ATTEMPTS.
      claimResults: [[{ amountCents: 1000, failureCount: 2 }]],
      customerRow: { stripeCustomerId: 'cus_1' },
      workspace,
      admins,
      adminUsers,
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_1' } }),
        },
        paymentIntents: { create: vi.fn().mockRejectedValue(new Error('Your card was declined.')) },
      },
    });
    const svc = new AiCreditsService(db, stripe, notificationsStub({ notify }), emailStub({ send }));

    const outcome = await svc.tryAutoReload('ws1');

    expect(outcome).toBe('disabled');
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ autoReloadEnabled: false, autoReloadFailureCount: 3, autoReloadNextRetryAt: null }),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'auto_reload_failed' }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'auto-reload-failed', to: 'admin@acme.test', workspaceName: 'Acme' }),
    );
  });

  it('treats "no default payment method" as a failure like any other decline, not a crash', async () => {
    const { db } = makeAutoReloadDb({
      claimResults: [[{ amountCents: 1000, failureCount: 0 }]],
      customerRow: { stripeCustomerId: 'cus_1' },
      workspace,
      admins,
      adminUsers,
    });
    const stripe = stripeStub(true, {
      client: {
        customers: {
          retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: null } }),
        },
        paymentIntents: { create: vi.fn() },
      },
    });
    const svc = new AiCreditsService(db, stripe, notificationsStub(), emailStub());

    expect(await svc.tryAutoReload('ws1')).toBe('retrying');
  });
});
