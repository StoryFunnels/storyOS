import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberships } from '../db/schema';

/**
 * The PERSON a workspace-level event belongs to: the workspace's founding admin
 * (its earliest active admin). `workspaces` records no creator, and Stripe checkout
 * does not record who started it, so this is derived — and it is the right join key
 * rather than a compromise: the funnel is sign-up -> activated -> paid per person,
 * and the person who signed up and created the workspace is the one every later
 * stage has to land on. If a different admin happens to press "upgrade", the paid
 * event must still join to the person who signed up.
 */
export async function foundingAdminId(db: Pick<Db, 'select'>, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row?.userId ?? null;
}
