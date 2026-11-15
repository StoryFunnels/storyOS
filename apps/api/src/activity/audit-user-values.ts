import type { ResolvedMember } from '../members/members-db.service';
import type { PresentedAuditRecord } from './audit-record-presenter';
import { SYSTEM_ACTOR_LABELS } from './audit-actor';

/**
 * Ticket #1287 - how a `user` field's value reads in `old_display` / `new_display`. A user field stores a bare better-auth user id
 * (ADR-0017), so the raw value is never a thing a person can read; this is the one function that turns it into words, for a single
 * person and for a multi-person field alike, so the two cannot drift.
 *
 * What a label can be, in the order it is decided:
 *   - a SYSTEM id (`system`, `system:...`)                   the process, by what it is ("Members sync", else "StoryOS")
 *   - an AGENT id (`agent:...`)                              "An agent"
 *   - a person whose Members row this viewer may not read    "A person you cannot see"   (never the name, never the id)
 *   - a person who has left (Members row tombstoned, ADR-0017) or has no row     "A former member"
 *   - otherwise                                              the member's name
 * The visibility rule is not new: the person is a record in the Members system database, and the viewer is told the name exactly when
 * the shared record gate (`presentAuditRecords`: database, space and record grants, personal-space door) lets them read that record.
 * No branch ever returns the id it was given.
 */
export const HIDDEN_PERSON_LABEL = 'A person you cannot see';
export const FORMER_MEMBER_LABEL = 'A former member';
export const AGENT_LABEL = 'An agent';

export interface UserLabelContext {
  /** user id -> its Members row (resolveMembersForUsers). A missing key is a person with no surviving row. */
  members: ReadonlyMap<string, Pick<ResolvedMember, 'recordId' | 'name' | 'active'>>;
  /** Members-row record id -> what THIS viewer may read of it (presentAuditRecords). A missing key counts as not readable. */
  visible: ReadonlyMap<string, Pick<PresentedAuditRecord, 'withheld'>>;
}

export function labelUser(id: string, ctx: UserLabelContext): string {
  if (id === 'system' || id.startsWith('system:')) return SYSTEM_ACTOR_LABELS[id] ?? 'StoryOS';
  if (id.startsWith('agent:')) return AGENT_LABEL;
  const member = ctx.members.get(id);
  if (!member) return FORMER_MEMBER_LABEL;
  const seen = ctx.visible.get(member.recordId);
  if (!seen || seen.withheld) return HIDDEN_PERSON_LABEL;
  return member.active ? member.name : FORMER_MEMBER_LABEL;
}

/** A stored user-field value (null, one id, or a list of ids) as labels, keeping its shape. Anything that is not an id string stays as is. */
export function displayUserValue(value: unknown, ctx: UserLabelContext): unknown {
  const one = (v: unknown) => (typeof v === 'string' && v.trim() ? labelUser(v, ctx) : v);
  return Array.isArray(value) ? value.map(one) : one(value);
}

/** Every user id a stored value names, for the one batched Members read. */
export function userIdsIn(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}
