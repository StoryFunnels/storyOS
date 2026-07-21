import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { NotificationsService } from '../notifications/notifications.service';
import type { EmailService } from '../mail/email.service';
import { TrialRemindersService } from './trial-reminders.service';

/**
 * A fake Db mirroring billing.service.test.ts's makeDb() shape: only the exact
 * call chains TrialRemindersService uses are implemented.
 *
 * `findMany` picks day-23 vs day-29 candidates by rendering the actual `where`
 * SQL (via PgDialect, same as the dedicated "gates the candidate query" test
 * below) and checking which sent-at column it references — robust to however
 * two concurrent `sweep()` calls happen to interleave their day-23/day-29
 * queries, unlike a naive "call N is always day-23" counter.
 *
 * `update(...).set(...).where(...).returning()` is the atomic claim. Which
 * milestone it claims is read off the *keys of `.set()`'s payload*
 * (`trialReminder23SentAt` vs `trialReminder29SentAt`) — the real service
 * always sets exactly one of those two keys — so the fake never needs to
 * parse the opaque `where` SQL to know which milestone is being claimed. Each
 * milestone gets its own queue of `.returning()` results, popped one per call
 * (default: an infinite supply of a single successful claim), so a test can
 * simulate "the second sweep tick's claim finds the column already set" by
 * queuing `[[{ workspaceId }], []]`.
 */
function makeDb(opts: {
  candidates23?: Array<{ workspaceId: string; trialEndsAt: Date }>;
  candidates29?: Array<{ workspaceId: string; trialEndsAt: Date }>;
  claim23Results?: Array<Array<{ workspaceId: string }>>;
  claim29Results?: Array<Array<{ workspaceId: string }>>;
  workspace?: { id: string; name: string; slug: string };
  admins?: Array<{ userId: string }>;
  adminUsers?: Array<{ id: string; email: string; name?: string }>;
}) {
  const findManyCalls: SQL[] = [];
  const dialect = new PgDialect();
  let claim23Idx = 0;
  let claim29Idx = 0;

  const claim23Queue = opts.claim23Results ?? [[{ workspaceId: opts.candidates23?.[0]?.workspaceId ?? 'ws1' }]];
  const claim29Queue = opts.claim29Results ?? [[{ workspaceId: opts.candidates29?.[0]?.workspaceId ?? 'ws1' }]];

  const db = {
    query: {
      billingSubscriptions: {
        findMany: vi.fn(async ({ where }: { where: SQL }) => {
          findManyCalls.push(where);
          const sql = dialect.sqlToQuery(where).sql;
          return sql.includes('trial_reminder_23_sent_at') ? (opts.candidates23 ?? []) : (opts.candidates29 ?? []);
        }),
      },
      workspaces: { findFirst: vi.fn(async () => opts.workspace) },
      memberships: { findMany: vi.fn(async () => opts.admins ?? []) },
      user: { findMany: vi.fn(async () => opts.adminUsers ?? []) },
    },
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if ('trialReminder23SentAt' in vals) {
              const queue = claim23Queue;
              const result = queue[Math.min(claim23Idx, queue.length - 1)]!;
              claim23Idx++;
              return result;
            }
            const queue = claim29Queue;
            const result = queue[Math.min(claim29Idx, queue.length - 1)]!;
            claim29Idx++;
            return result;
          },
        }),
      }),
    })),
  } as unknown as Db;

  return { db, findManyCalls };
}

const workspace = { id: 'ws1', name: 'Acme', slug: 'acme' };
const admins = [{ userId: 'u1' }];
const adminUsers = [{ id: 'u1', email: 'admin@acme.test', name: 'Admin' }];

describe('TrialRemindersService.sweep', () => {
  it('fires an in-app notification and an email once at day 23 of an active no-card trial', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb({
      candidates23: [{ workspaceId: 'ws1', trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }],
      workspace,
      admins,
      adminUsers,
    });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await svc.sweep();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', type: 'trial_reminder_23', recipients: ['u1'] }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trial-reminder', to: 'admin@acme.test', daysRemaining: 7, workspaceName: 'Acme' }),
      'ws1', // MN-194 — cost-attribution workspaceId, threaded through EmailService.send
    );
  });

  it('fires once at day 29 (1 day remaining)', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb({
      candidates29: [{ workspaceId: 'ws1', trialEndsAt: new Date(Date.now() + 1 * 86_400_000) }],
      workspace,
      admins,
      adminUsers,
    });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await svc.sweep();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'trial_reminder_29' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ daysRemaining: 1 }), 'ws1');
  });

  it('never fires for a Stripe-backed (paid) subscription — the DB query excludes it, so no candidates come back', async () => {
    // A real Stripe-backed subscription fails `isNull(stripeSubscriptionId)` in
    // the service's own query, so it would never be among `findMany`'s
    // results — modelled here by simply not seeding it as a candidate at all,
    // exactly like billing.service.test.ts's fakes model "the DB already
    // filtered this out". See the 'gates the candidate query on the no-card,
    // trialing status' test below for a direct assertion on that WHERE clause.
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb({ candidates23: [], candidates29: [], workspace, admins, adminUsers });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await svc.sweep();

    expect(notify).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('gates the candidate query on no-card ("stripe_subscription_id" is null) trialing rows, one column per milestone', async () => {
    // No candidates seeded — this test only inspects the WHERE clause itself,
    // the actual guarantee behind "never fires for Stripe-backed/paid plans"
    // and "day 23 vs day 29 are distinct queries" (as opposed to trusting that
    // the mocked findMany already filtered correctly, like the test above).
    const { db, findManyCalls } = makeDb({ workspace, admins, adminUsers });
    const svc = new TrialRemindersService(db, {} as unknown as NotificationsService, {} as unknown as EmailService);

    await svc.sweep();

    const dialect = new PgDialect();
    const [day23Where, day29Where] = findManyCalls;
    const day23 = dialect.sqlToQuery(day23Where!);
    const day29 = dialect.sqlToQuery(day29Where!);

    for (const q of [day23, day29]) {
      expect(q.sql).toContain('"stripe_subscription_id" is null');
      expect(q.sql).toContain('"status" =');
      expect(q.params).toContain('trialing');
    }
    expect(day23.sql).toContain('"trial_reminder_23_sent_at" is null');
    expect(day29.sql).toContain('"trial_reminder_29_sent_at" is null');
  });

  it('idempotent: two sweep passes over the same unclaimed candidate fire exactly once per milestone (the atomic claim guards the second)', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const trialEndsAt23 = new Date(Date.now() + 7 * 86_400_000);
    const trialEndsAt29 = new Date(Date.now() + 1 * 86_400_000);
    // Both sweep() calls see the same still-unclaimed row — the exact race a
    // restart or an overlapping tick produces (the SELECT of the second tick
    // ran before the first tick's UPDATE committed). The claim queues model
    // Postgres's own atomicity: only the first `.returning()` for each
    // milestone succeeds; every later one finds the column already set.
    const { db } = makeDb({
      candidates23: [{ workspaceId: 'ws1', trialEndsAt: trialEndsAt23 }],
      candidates29: [{ workspaceId: 'ws1', trialEndsAt: trialEndsAt29 }],
      claim23Results: [[{ workspaceId: 'ws1' }], []],
      claim29Results: [[{ workspaceId: 'ws1' }], []],
      workspace,
      admins,
      adminUsers,
    });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await svc.sweep();
    await svc.sweep();

    expect(notify).toHaveBeenCalledTimes(2); // one for trial_reminder_23, one for trial_reminder_29 — never 4
    expect(send).toHaveBeenCalledTimes(2);
    const types = notify.mock.calls.map((c) => (c[0] as { type: string }).type).sort();
    expect(types).toEqual(['trial_reminder_23', 'trial_reminder_29']);
  });

  it('idempotent under concurrent/overlapping sweep ticks (Promise.all), not just sequential re-runs', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb({
      candidates23: [{ workspaceId: 'ws1', trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }],
      candidates29: [],
      claim23Results: [[{ workspaceId: 'ws1' }], []],
      workspace,
      admins,
      adminUsers,
    });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await Promise.all([svc.sweep(), svc.sweep()]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the workspace has no active admin to notify', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb({
      candidates23: [{ workspaceId: 'ws1', trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }],
      workspace,
      admins: [],
      adminUsers: [],
    });
    const svc = new TrialRemindersService(db, { notify } as unknown as NotificationsService, {
      send,
    } as unknown as EmailService);

    await svc.sweep();

    expect(notify).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
