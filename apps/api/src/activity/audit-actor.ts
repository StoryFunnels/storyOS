import type { ResolvedMember } from '../members/members-db.service';

/**
 * Ticket #1287 - how an audit row names WHO acted, in words. One function, so the two row kinds (event, field change) cannot name an
 * actor differently, and so no row ever prints an auth id as if it were a name.
 *
 * actor_kind: 'member' (a person, possibly removed) | 'system' (a StoryOS process, not a person) | null (no actor recorded).
 * actor_removed: true only for a member who has left (their Members row is tombstoned, ADR-0017, or no row survives). Never true for
 * a system actor: "(removed member)" for the Members sync was the wrong sentence.
 */
export const SYSTEM_ACTOR_LABELS: Record<string, string> = {
  'system:members-projection': 'Members sync',
};

export interface PresentedAuditActor {
  actor_name: string | null;
  actor_kind: 'member' | 'system' | null;
  actor_removed: boolean;
}

export function presentAuditActor(actorId: string | null, member: Pick<ResolvedMember, 'name' | 'active'> | undefined): PresentedAuditActor {
  if (!actorId) return { actor_name: null, actor_kind: null, actor_removed: false };
  if (actorId === 'system' || actorId.startsWith('system:')) {
    return { actor_name: SYSTEM_ACTOR_LABELS[actorId] ?? 'StoryOS', actor_kind: 'system', actor_removed: false };
  }
  if (!member) return { actor_name: 'A former member', actor_kind: 'member', actor_removed: true };
  return { actor_name: member.name, actor_kind: 'member', actor_removed: !member.active };
}
