import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { AbuseFlagsService, RECORD_WRITE_HOURLY_THRESHOLD } from './abuse-flags.service';

/** A fake Db capturing the counter upsert and any flag insert. */
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
          // usage_counters upsert path: pretend the running total is exactly
          // what was just added on top of nothing, for a deterministic test.
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

describe('AbuseFlagsService.recordWrites — detection only, never blocks', () => {
  it('never throws, even with a tiny write count', async () => {
    const { db } = makeDb();
    const svc = new AbuseFlagsService(db);
    await expect(svc.recordWrites('ws1', 1)).resolves.toBeUndefined();
  });

  it('does not flag below the threshold', async () => {
    const { db, flagInserts } = makeDb();
    const svc = new AbuseFlagsService(db);

    await svc.recordWrites('ws1', RECORD_WRITE_HOURLY_THRESHOLD - 1);

    expect(flagInserts).toHaveLength(0);
  });

  it('flags exactly at the threshold, with the crossing value and threshold recorded', async () => {
    const { db, flagInserts } = makeDb();
    const svc = new AbuseFlagsService(db);

    await svc.recordWrites('ws1', RECORD_WRITE_HOURLY_THRESHOLD);

    expect(flagInserts).toHaveLength(1);
    expect(flagInserts[0]).toMatchObject({
      workspaceId: 'ws1',
      metric: 'record_writes_hourly',
      value: RECORD_WRITE_HOURLY_THRESHOLD,
      threshold: RECORD_WRITE_HOURLY_THRESHOLD,
    });
  });

  it('does not double-flag within the same hour — the unique constraint makes it idempotent', async () => {
    const { db, flagInserts } = makeDb({ flagAlreadyExists: true });
    const svc = new AbuseFlagsService(db);

    await svc.recordWrites('ws1', RECORD_WRITE_HOURLY_THRESHOLD + 500);

    expect(flagInserts).toHaveLength(0); // onConflictDoNothing found the existing row
  });
});

describe('AbuseFlagsService — MN-195 never introduces a cap', () => {
  it('recordWrites has no return value a caller could act on to block anything', async () => {
    const { db } = makeDb();
    const svc = new AbuseFlagsService(db);
    const result = await svc.recordWrites('ws1', RECORD_WRITE_HOURLY_THRESHOLD * 10);
    expect(result).toBeUndefined();
  });
});
