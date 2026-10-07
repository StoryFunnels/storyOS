import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberships } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { GithubConfig } from './github.service';

/**
 * The identity a webhook-driven (or #476 reconciliation-tick-driven) write acts
 * as: the admin who configured the integration, falling back to any active
 * admin (the config predates #42 in existing workspaces). A demoted or departed
 * configurer yields no actor at all rather than a write from a ghost.
 *
 * A standalone module (not a method on either service) so GithubWebhookService
 * and GithubService's own reconciliation tick can share it without creating a
 * GithubWebhookService↔GithubService import cycle — GithubWebhookService already
 * depends on GithubService for upsert/ensurePack.
 */
export async function resolveGithubActor(
  db: Db,
  workspaceId: string,
  config: GithubConfig,
): Promise<Membership | null> {
  if (config.webhook_actor_id) {
    const membership = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, config.webhook_actor_id)),
    });
    if (membership && membership.status === 'active') return membership;
  }
  const admins = await db.query.memberships.findMany({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin')),
  });
  return admins.find((m) => m.status === 'active') ?? null;
}
