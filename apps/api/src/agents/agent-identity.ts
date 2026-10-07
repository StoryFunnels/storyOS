import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases, memberships, records } from '../db/schema';

export interface ResolvedAgentIdentity {
  /** The agent record's CURRENT owner — always re-resolved live, never trusted
   * from a token's stored value (#541 AC: "resolved from the credential ...
   * not a field the agent supplies", extended to mean not a STALE credential
   * either). */
  ownerId: string;
  /** The agent's `title` at resolution time — callers snapshot this onto the
   * write they're about to make, so a later rename doesn't retcon history. */
  agentName: string;
}

/**
 * #541 — the one fail-closed check every agent-scoped token must pass, on
 * EVERY use: is `agentId` still a real, non-deleted record in THIS
 * workspace's "Agents" database, and is its owner still an active member?
 * Null means refuse — there is no fallback identity to fall back to (an
 * agent's writes are never attributed to "the system" or "an admin").
 *
 * Deliberately dependency-free (raw schema queries, no service injection):
 * this needs to be callable from `auth.guard.ts`, which cannot safely depend
 * on `AgentsService`/`RecordsService` (both sit behind `AuthModule` in the
 * module graph — injecting either here would be circular). An Agent's owner
 * is just `records.createdBy` on its own row, so this needs nothing heavier
 * than the schema itself.
 */
export async function resolveAgentIdentity(
  db: Db,
  workspaceId: string,
  agentId: string,
): Promise<ResolvedAgentIdentity | null> {
  const agentsDb = await db.query.databases.findFirst({
    where: and(eq(databases.workspaceId, workspaceId), eq(databases.name, 'Agents'), isNull(databases.deletedAt)),
    columns: { id: true },
  });
  if (!agentsDb) return null;

  const agentRecord = await db.query.records.findFirst({
    where: and(eq(records.id, agentId), eq(records.databaseId, agentsDb.id), isNull(records.deletedAt)),
    columns: { title: true, createdBy: true },
  });
  if (!agentRecord?.createdBy) return null;

  const membership = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, agentRecord.createdBy)),
    columns: { status: true },
  });
  if (!membership || membership.status !== 'active') return null;

  return { ownerId: agentRecord.createdBy, agentName: agentRecord.title };
}
