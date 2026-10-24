import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases } from '../db/schema';

/**
 * #1029 — a database id is only meaningful INSIDE the workspace it belongs to. `getRow` and friends filter on the
 * record and database ids alone, so a caller that holds a victim's ids and ANY workspace's authority used to reach
 * across tenants (agent approve soft-deleted, overwrote and exfiltrated another workspace's records). Every internal
 * path that applies a write on behalf of a workspace calls this first. 404, not 403: the same no-leak answer the guards give.
 */
export async function assertDatabaseInWorkspace(db: Db, workspaceId: string, databaseId: string): Promise<void> {
  const [row] = await db
    .select({ id: databases.id })
    .from(databases)
    .where(and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new NotFoundException('Database not found');
}
