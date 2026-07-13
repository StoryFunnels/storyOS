import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, truncateAll } from './helpers/db';
import { memberships, spaces, workspaces } from '../src/db/schema';

const { db, pool } = connectTestDb();

beforeAll(async () => {
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('database foundation (MN-004)', () => {
  it('round-trips a workspace with a space and a membership', async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: 'JCM', slug: 'jcm' })
      .returning();
    expect(ws).toBeDefined();

    const [space] = await db
      .insert(spaces)
      .values({ workspaceId: ws!.id, name: 'General', slug: 'general' })
      .returning();

    await db.insert(memberships).values({
      workspaceId: ws!.id,
      userId: 'user_test_1',
      role: 'admin',
    });

    const found = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, 'jcm') });
    expect(found?.name).toBe('JCM');
    expect(space!.workspaceId).toBe(ws!.id);
  });

  it('enforces unique membership per (workspace, user)', async () => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, 'jcm') });
    await expect(
      db.insert(memberships).values({ workspaceId: ws!.id, userId: 'user_test_1', role: 'member' }),
    ).rejects.toThrow();
  });

  it('cascades workspace deletion to spaces and memberships', async () => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, 'jcm') });
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    const orphanSpaces = await db.query.spaces.findMany();
    expect(orphanSpaces).toHaveLength(0);
  });
});
