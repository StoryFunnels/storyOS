import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { TYRON_TOKENS_DAILY_THRESHOLD, TYRON_TOKENS_METRIC, TyronSpendGuardService } from './tyron-spend-guard.service';

/** Same fake-Db shape as abuse-flags.service.test.ts — this service is
 * MN-195's pattern applied to a different metric, so it deserves the same
 * test shape rather than a parallel invention. */
function makeDb(opts: { flagAlreadyExists?: boolean } = {}) {
  const flagInserts: Record<string, unknown>[] = [];
  const db = {
    insert: () => {
      let vals: Record<string, unknown> = {};
      return {
        values(v: Record<string, unknown>) {
          vals = v;
          return this;
        },
        onConflictDoUpdate() {
          return { returning: async () => [{ count: vals['count'] }] };
        },
        onConflictDoNothing() {
          return {
            returning: async () => {
              if (opts.flagAlreadyExists) return [];
              flagInserts.push(vals);
              return [{ id: 'flag_1' }];
            },
          };
        },
      };
    },
  } as unknown as Db;
  return { db, flagInserts };
}

describe('TyronSpendGuardService.recordUsage — detection only, never blocks (#353)', () => {
  it('never throws, even with tiny usage', async () => {
    const { db } = makeDb();
    const svc = new TyronSpendGuardService(db);
    await expect(svc.recordUsage('ws1', 10, 5)).resolves.toBeUndefined();
  });

  it('is a no-op for zero usage — nothing to measure, nothing to flag', async () => {
    const { db, flagInserts } = makeDb();
    const svc = new TyronSpendGuardService(db);
    await svc.recordUsage('ws1', 0, 0);
    expect(flagInserts).toHaveLength(0);
  });

  it('does not flag below the daily threshold', async () => {
    const { db, flagInserts } = makeDb();
    const svc = new TyronSpendGuardService(db);

    await svc.recordUsage('ws1', TYRON_TOKENS_DAILY_THRESHOLD - 100, 99);

    expect(flagInserts).toHaveLength(0);
  });

  it('flags at the threshold, recording the metric name, crossing value, and threshold', async () => {
    const { db, flagInserts } = makeDb();
    const svc = new TyronSpendGuardService(db);

    await svc.recordUsage('ws1', TYRON_TOKENS_DAILY_THRESHOLD, 0);

    expect(flagInserts).toHaveLength(1);
    expect(flagInserts[0]).toMatchObject({
      workspaceId: 'ws1',
      metric: TYRON_TOKENS_METRIC,
      value: TYRON_TOKENS_DAILY_THRESHOLD,
      threshold: TYRON_TOKENS_DAILY_THRESHOLD,
    });
  });

  it('does not double-flag the same day — the unique constraint makes it idempotent', async () => {
    const { db, flagInserts } = makeDb({ flagAlreadyExists: true });
    const svc = new TyronSpendGuardService(db);

    await svc.recordUsage('ws1', TYRON_TOKENS_DAILY_THRESHOLD + 1000, 0);

    expect(flagInserts).toHaveLength(0); // onConflictDoNothing found the existing row
  });

  it('has no return value a caller could act on to block or slow a turn', async () => {
    const { db } = makeDb();
    const svc = new TyronSpendGuardService(db);
    const result = await svc.recordUsage('ws1', TYRON_TOKENS_DAILY_THRESHOLD * 10, 0);
    expect(result).toBeUndefined();
  });
});
