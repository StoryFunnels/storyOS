import { currentActor } from '../common/credential-context';
import type { Db } from '../db/client';
import { activityEvents } from '../db/schema';

/** The transaction type `db.transaction(async (tx) => ...)` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * #1059 — structural audit events: a space, a database or a view deleted, restored, restricted or unrestricted. They live in the SAME
 * `activity_events` table the record events do (no second stream; `record_id` is null), typed `<kind>.<action>`, with the object in the
 * payload as `{ object: { kind, id, name } }`, so the workspace audit log reads them with the query it already has.
 *
 * `purged` is part of the vocabulary on purpose and is NOT emitted today: nothing in the codebase permanently removes a space, database
 * or view (everything is a soft delete, ticket #453). The day a purge path exists it MUST call `recordStructuralEvent` with `purged`;
 * `test/audit-structural.test.ts` lists every way a structural object can leave the tree so that path cannot be added silently.
 *
 * Attribution comes from the request's actor context (`common/credential-context.ts`): REST and MCP both arrive as an authenticated
 * request, so both are attributed, with the right `source` badge. No request (a job, a script) means null actor and null source:
 * recorded as absence, never as a person.
 */
export const STRUCTURAL_KINDS = ['space', 'database', 'view'] as const;
export const STRUCTURAL_ACTIONS = ['deleted', 'restored', 'purged', 'restricted', 'unrestricted'] as const;
export type StructuralKind = (typeof STRUCTURAL_KINDS)[number];
export type StructuralAction = (typeof STRUCTURAL_ACTIONS)[number];
export const STRUCTURAL_EVENT_TYPES: string[] = STRUCTURAL_KINDS.flatMap((k) => STRUCTURAL_ACTIONS.map((a) => `${k}.${a}`));

export async function recordStructuralEvent(
  db: Db | Tx,
  event: {
    workspaceId: string;
    kind: StructuralKind;
    action: StructuralAction;
    id: string;
    name: string;
    /** Extra facts about the event (what a space delete took with it, which database a view belonged to...). Never a person's private content. */
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const actor = currentActor();
  await db.insert(activityEvents).values({
    workspaceId: event.workspaceId,
    recordId: null,
    actorId: actor?.userId ?? null,
    type: `${event.kind}.${event.action}`,
    payload: { object: { kind: event.kind, id: event.id, name: event.name }, ...(event.extra ?? {}) },
    source: actor?.source ?? null,
    agentId: actor?.agentId ?? null,
    agentName: actor?.agentName ?? null,
  });
}

/**
 * Ticket #536 — a portal recipient's link created, rotated or revoked. Same table, same query, same actor attribution as the
 * structural events above (actor = the member, `source` as the call came), typed `portal_recipient.<action>` with the object in
 * the payload. Deliberately NOT in STRUCTURAL_KINDS: that is the space/database/view vocabulary and is crossed with its actions to
 * build STRUCTURAL_EVENT_TYPES, which would mint `portal_recipient.deleted` and friends that never happen.
 *
 * The payload is the recipient's id and label ONLY. The token, its signature and its version are never written here: a log row
 * that carried the credential would make the audit log a second place to steal a live link from.
 */
export const PORTAL_RECIPIENT_ACTIONS = ['created', 'rotated', 'revoked'] as const;
export type PortalRecipientAction = (typeof PORTAL_RECIPIENT_ACTIONS)[number];
export const PORTAL_RECIPIENT_EVENT_TYPES: string[] = PORTAL_RECIPIENT_ACTIONS.map((a) => `portal_recipient.${a}`);

export async function recordPortalRecipientEvent(
  db: Db | Tx,
  event: { workspaceId: string; action: PortalRecipientAction; id: string; label: string },
): Promise<void> {
  const actor = currentActor();
  await db.insert(activityEvents).values({
    workspaceId: event.workspaceId,
    recordId: null,
    actorId: actor?.userId ?? null,
    type: `portal_recipient.${event.action}`,
    payload: { object: { kind: 'portal_recipient', id: event.id, name: event.label } },
    source: actor?.source ?? null,
    agentId: actor?.agentId ?? null,
    agentName: actor?.agentName ?? null,
  });
}
