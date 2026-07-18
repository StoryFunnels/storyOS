import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { PlatformAdminService } from './platform-admin.service';

function makeDb(opts: { adminRow?: unknown; userRow?: unknown }) {
  const inserts: Record<string, unknown>[] = [];
  const deletes: { where: unknown }[] = [];
  const db = {
    query: {
      platformAdmins: {
        findFirst: vi.fn().mockResolvedValue(opts.adminRow),
      },
      user: {
        findFirst: vi.fn().mockResolvedValue(opts.userRow),
      },
    },
    insert: () => ({
      values(v: Record<string, unknown>) {
        inserts.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    delete: () => ({
      where(w: unknown) {
        deletes.push({ where: w });
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { db, inserts, deletes };
}

describe('PlatformAdminService.isPlatformAdmin', () => {
  it('true when a row exists', async () => {
    const { db } = makeDb({ adminRow: { userId: 'u1' } });
    const svc = new PlatformAdminService(db);
    expect(await svc.isPlatformAdmin('u1')).toBe(true);
  });

  it('false when no row exists', async () => {
    const { db } = makeDb({ adminRow: undefined });
    const svc = new PlatformAdminService(db);
    expect(await svc.isPlatformAdmin('u1')).toBe(false);
  });
});

describe('PlatformAdminService.seedFromEnv', () => {
  it('grants the matching user when found', async () => {
    const { db, inserts } = makeDb({ userRow: { id: 'u1', email: 'ops@storyos.dev' } });
    const svc = new PlatformAdminService(db);

    await svc.seedFromEnv('ops@storyos.dev');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ userId: 'u1', grantedBy: null });
  });

  it('no-ops when no user with that email exists yet', async () => {
    const { db, inserts } = makeDb({ userRow: undefined });
    const svc = new PlatformAdminService(db);

    await expect(svc.seedFromEnv('nobody@storyos.dev')).resolves.toBeUndefined();

    expect(inserts).toHaveLength(0);
  });
});

describe('PlatformAdminService.grant / revoke', () => {
  it('grant records who granted it', async () => {
    const { db, inserts } = makeDb({});
    const svc = new PlatformAdminService(db);

    await svc.grant('u2', 'u1');

    expect(inserts[0]).toMatchObject({ userId: 'u2', grantedBy: 'u1' });
  });

  it('revoke deletes the row', async () => {
    const { db, deletes } = makeDb({});
    const svc = new PlatformAdminService(db);

    await svc.revoke('u2');

    expect(deletes).toHaveLength(1);
  });
});
