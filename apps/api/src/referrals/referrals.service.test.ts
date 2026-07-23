import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { REFERRAL_REWARD_CENTS, ReferralsService } from './referrals.service';

/**
 * A fake Db, same style as billing.service.test.ts: each `findFirst`/`findMany`
 * is configured with the exact row(s) a test wants back, rather than
 * re-implementing drizzle's query matching. `insert(...).onConflictDoNothing()
 * .returning()` resolves to `conflictReturn` (default: the row "won" the
 * insert); `update(...).where().returning()` resolves to `updateReturn`.
 */
function makeDb(opts: {
  codeRow?: { userId: string; code: string };
  membershipRows?: Array<{ workspaceId: string; userId: string; role: string }>;
  pendingSignupRow?: { id: string; refereeUserId: string; referrerUserId: string; code: string; convertedAt: Date | null };
  allSignupRows?: Array<{ convertedAt: Date | null }>;
  rewardGrantRows?: Array<{ amountCents: number }>;
  codeConflictReturn?: Array<{ code: string }>;
  signupConflictReturn?: Array<{ id: string }>;
  updateReturn?: Array<{ id: string }>;
}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];

  const db = {
    query: {
      referralCodes: { findFirst: vi.fn().mockResolvedValue(opts.codeRow) },
      referralSignups: {
        findFirst: vi.fn().mockResolvedValue(opts.pendingSignupRow),
        findMany: vi.fn().mockResolvedValue(opts.allSignupRows ?? []),
      },
      referralRewardGrants: { findMany: vi.fn().mockResolvedValue(opts.rewardGrantRows ?? []) },
      memberships: { findMany: vi.fn().mockResolvedValue(opts.membershipRows ?? []) },
    },
    insert: () => {
      let vals: Record<string, unknown> = {};
      let target: 'code' | 'signup' | 'grant' = 'grant';
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          inserted.push(v);
          if ('refereeUserId' in v) target = 'signup';
          else if ('signupId' in v) target = 'grant';
          else if ('code' in v) target = 'code';
          else target = 'grant';
          return this;
        },
        onConflictDoNothing() {
          return {
            returning: async () =>
              target === 'code' ? (opts.codeConflictReturn ?? [{ code: vals.code as string }]) : (opts.signupConflictReturn ?? [{ id: 'new_signup' }]),
          };
        },
        returning: async () => [vals],
      };
    },
    update: () => {
      let vals: Record<string, unknown> = {};
      return {
        set(v: Record<string, unknown>) {
          vals = v;
          return this;
        },
        where: () => ({
          returning: async () => {
            updated.push(vals);
            return opts.updateReturn ?? [{ id: 'signup_1' }];
          },
        }),
      };
    },
  } as unknown as Db;

  return { db, inserted, updated };
}

describe('ReferralsService.getOrCreateCode', () => {
  it('returns the existing code without inserting when one already exists', async () => {
    const { db, inserted } = makeDb({ codeRow: { userId: 'user_1', code: 'EXIST123' } });
    const svc = new ReferralsService(db);

    const code = await svc.getOrCreateCode('user_1');

    expect(code).toBe('EXIST123');
    expect(inserted).toHaveLength(0);
  });

  it('generates and persists a new 8-character code for a first-time user', async () => {
    const { db, inserted } = makeDb({ codeRow: undefined });
    const svc = new ReferralsService(db);

    const code = await svc.getOrCreateCode('user_1');

    expect(code).toHaveLength(8);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ userId: 'user_1' });
  });
});

describe('ReferralsService.attribute', () => {
  it('attributes a referred sign-up for a known code', async () => {
    const { db, inserted } = makeDb({ codeRow: { userId: 'referrer_1', code: 'ABCD1234' } });
    const svc = new ReferralsService(db);

    const result = await svc.attribute('referee_1', 'ABCD1234');

    expect(result).toEqual({ attributed: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ referrerUserId: 'referrer_1', refereeUserId: 'referee_1', code: 'ABCD1234' });
  });

  it('no-ops on an unknown code — best-effort, never blocks sign-up', async () => {
    const { db, inserted } = makeDb({ codeRow: undefined });
    const svc = new ReferralsService(db);

    const result = await svc.attribute('referee_1', 'NOPE0000');

    expect(result).toEqual({ attributed: false });
    expect(inserted).toHaveLength(0);
  });

  it('refuses a self-referral', async () => {
    const { db, inserted } = makeDb({ codeRow: { userId: 'user_1', code: 'ABCD1234' } });
    const svc = new ReferralsService(db);

    const result = await svc.attribute('user_1', 'ABCD1234');

    expect(result).toEqual({ attributed: false });
    expect(inserted).toHaveLength(0);
  });

  it('is idempotent — a duplicate attribution attempt (conflict) reports not-attributed', async () => {
    const { db } = makeDb({ codeRow: { userId: 'referrer_1', code: 'ABCD1234' }, signupConflictReturn: [] });
    const svc = new ReferralsService(db);

    const result = await svc.attribute('referee_1', 'ABCD1234');

    expect(result).toEqual({ attributed: false });
  });
});

describe('ReferralsService.recordConversionIfEligible', () => {
  it('grants a reward the first time a referred workspace goes paid', async () => {
    const { db, updated, inserted } = makeDb({
      membershipRows: [{ workspaceId: 'ws1', userId: 'referee_1', role: 'admin' }],
      pendingSignupRow: {
        id: 'signup_1',
        refereeUserId: 'referee_1',
        referrerUserId: 'referrer_1',
        code: 'ABCD1234',
        convertedAt: null,
      },
      updateReturn: [{ id: 'signup_1' }],
    });
    const svc = new ReferralsService(db);

    await svc.recordConversionIfEligible('ws1');

    expect(updated).toHaveLength(1);
    const grant = inserted.find((v) => 'signupId' in v);
    expect(grant).toMatchObject({
      signupId: 'signup_1',
      referrerUserId: 'referrer_1',
      amountCents: REFERRAL_REWARD_CENTS,
      reason: 'paid_conversion',
    });
  });

  it('is a no-op when the workspace has no admins', async () => {
    const { db, inserted } = makeDb({ membershipRows: [] });
    const svc = new ReferralsService(db);

    await svc.recordConversionIfEligible('ws1');

    expect(inserted).toHaveLength(0);
  });

  it('is a no-op when no admin was ever referred', async () => {
    const { db, inserted } = makeDb({
      membershipRows: [{ workspaceId: 'ws1', userId: 'unreferred_user', role: 'admin' }],
      pendingSignupRow: undefined,
    });
    const svc = new ReferralsService(db);

    await svc.recordConversionIfEligible('ws1');

    expect(inserted).toHaveLength(0);
  });

  it('never double-grants — a raced claim (update returns nothing) skips the reward insert', async () => {
    const { db, inserted } = makeDb({
      membershipRows: [{ workspaceId: 'ws1', userId: 'referee_1', role: 'admin' }],
      pendingSignupRow: {
        id: 'signup_1',
        refereeUserId: 'referee_1',
        referrerUserId: 'referrer_1',
        code: 'ABCD1234',
        convertedAt: null,
      },
      updateReturn: [], // another concurrent delivery already claimed it
    });
    const svc = new ReferralsService(db);

    await svc.recordConversionIfEligible('ws1');

    expect(inserted.some((v) => 'signupId' in v)).toBe(false);
  });
});

describe('ReferralsService.getSummary', () => {
  it('reports signups, paid conversions, and total reward cents', async () => {
    const { db } = makeDb({
      codeRow: { userId: 'user_1', code: 'MYCODE12' },
      allSignupRows: [{ convertedAt: new Date() }, { convertedAt: null }],
      rewardGrantRows: [{ amountCents: REFERRAL_REWARD_CENTS }],
    });
    const svc = new ReferralsService(db);

    const summary = await svc.getSummary('user_1', 'https://app.storyos.dev');

    expect(summary.code).toBe('MYCODE12');
    expect(summary.signups).toBe(2);
    expect(summary.paidConversions).toBe(1);
    expect(summary.rewardCents).toBe(REFERRAL_REWARD_CENTS);
    expect(summary.link).toBe('https://app.storyos.dev/signup?ref=MYCODE12');
  });
});
