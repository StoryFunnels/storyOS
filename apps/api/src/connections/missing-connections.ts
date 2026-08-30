import { and, eq } from 'drizzle-orm';
import { connections } from '../db/schema';
import type { Db } from '../db/client';

/**
 * #455 — which of `providers` this workspace holds no ACTIVE connection for.
 *
 * One implementation, two callers: the pack installer wording its note, and
 * the enable guard refusing a rule. If those two ever disagreed about what
 * "missing" means, a pack would say "connect Slack first" and then refuse a
 * rule for a different reason, or worse, allow one it had just warned about.
 *
 * `status` matters as much as existence: a connection whose auth has expired
 * is a row that is present and useless, and enabling a rule against one puts
 * the failure in the run log instead of in front of the person switching it on.
 */
export async function missingConnections(
  db: Db,
  workspaceId: string,
  providers: string[] | null | undefined,
): Promise<string[]> {
  if (!providers || providers.length === 0) return [];
  const rows = await db.query.connections.findMany({
    where: and(eq(connections.workspaceId, workspaceId), eq(connections.status, 'active')),
    columns: { provider: true },
  });
  const held = new Set(rows.map((r) => r.provider));
  return providers.filter((p) => !held.has(p));
}
