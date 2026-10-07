import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, lt } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, recordFieldChanges } from '../db/schema';
import { MembersDbService } from '../members/members-db.service';

/**
 * #454 — a read model and access boundary over data that ALREADY EXISTS
 * (activity_events, record_field_changes), not a new event stream. Every
 * record-level create/update/delete/restore is already captured; this makes
 * it visible workspace-wide instead of per-record, admin-only, filterable.
 *
 * KNOWN, STATED GAP (per this ticket's own AC #2): structural deletions of a
 * database, view or space are NOT emitted to activity_events today — none of
 * DatabasesService.remove()/SpacesService.remove()/ViewsService.remove() even
 * take an actorId parameter yet. That is a real, separate piece of work (at
 * minimum: thread actorId through all three, decide whether a space-cascaded
 * database deletion gets its own row) — flagged here rather than built
 * silently into this PR's scope or silently ignored. "Who deleted this
 * database" is NOT answerable from this endpoint yet; "who changed or
 * deleted this RECORD" is.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly members: MembersDbService,
  ) {}

  async list(
    workspaceId: string,
    filter: { actor?: string; entity?: string; from?: string; to?: string; limit?: number; cursor?: string },
  ) {
    const limit = filter.limit ?? 50;
    const to = filter.to ? new Date(filter.to) : new Date();
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const eventConditions = [
      eq(activityEvents.workspaceId, workspaceId),
      gte(activityEvents.createdAt, from),
      lte(activityEvents.createdAt, to),
    ];
    const changeConditions = [
      eq(recordFieldChanges.workspaceId, workspaceId),
      gte(recordFieldChanges.createdAt, from),
      lte(recordFieldChanges.createdAt, to),
    ];
    if (filter.actor) {
      eventConditions.push(eq(activityEvents.actorId, filter.actor));
      changeConditions.push(eq(recordFieldChanges.actorUserId, filter.actor));
    }
    if (filter.entity) {
      eventConditions.push(eq(activityEvents.recordId, filter.entity));
      changeConditions.push(eq(recordFieldChanges.recordId, filter.entity));
    }
    if (filter.cursor) {
      const created = new Date(Buffer.from(filter.cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) {
        eventConditions.push(lt(activityEvents.createdAt, created));
        changeConditions.push(lt(recordFieldChanges.createdAt, created));
      }
    }

    // Two independent tables, merged and re-sorted here rather than a SQL
    // UNION — record_field_changes carries a per-FIELD row (#31's design),
    // event carries a per-WRITE row; a caller reading "what happened" wants
    // both without needing to know that split exists.
    const [events, changes] = await Promise.all([
      this.db.query.activityEvents.findMany({
        where: and(...eventConditions),
        orderBy: [desc(activityEvents.createdAt)],
        limit: limit + 1,
      }),
      this.db.query.recordFieldChanges.findMany({
        where: and(...changeConditions),
        orderBy: [desc(recordFieldChanges.createdAt)],
        limit: limit + 1,
      }),
    ]);

    const fieldIds = [...new Set(changes.map((c) => c.fieldId).filter((id): id is string => Boolean(id)))];
    const fieldRows = fieldIds.length
      ? await this.db.query.fields.findMany({ where: (t, { inArray }) => inArray(t.id, fieldIds) })
      : [];
    const fieldName = new Map(fieldRows.map((f) => [f.id, f.displayName]));

    // #454 — the no-FK decision (schema.ts's actorUserId/actorId comments)
    // exists so a removed (or GDPR-erased) member's historical rows still
    // name someone. resolveMembersForUsers reads the Members system
    // database's TOMBSTONED rows, which survive both — the first production
    // caller of this method (it previously had none).
    const actorIds = [
      ...new Set(
        [...events.map((e) => e.actorId), ...changes.map((c) => c.actorUserId)].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ];
    const resolvedActors = await this.members.resolveMembersForUsers(workspaceId, actorIds);
    const actorName = (id: string | null) => (id ? (resolvedActors.get(id)?.name ?? '(unknown)') : null);

    const merged = [
      ...events.map((e) => ({
        kind: 'event' as const,
        id: e.id,
        record_id: e.recordId,
        type: e.type,
        actor_id: e.actorId,
        actor_name: actorName(e.actorId),
        source: e.source,
        payload: e.payload,
        created_at: e.createdAt,
      })),
      ...changes.map((c) => ({
        kind: 'field_change' as const,
        id: c.id,
        record_id: c.recordId,
        field: c.fieldId ? (fieldName.get(c.fieldId) ?? '(deleted field)') : 'Name',
        actor_id: c.actorUserId,
        actor_name: actorName(c.actorUserId),
        source: c.source,
        old_value: c.oldValue,
        new_value: c.newValue,
        created_at: c.createdAt,
      })),
    ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const page = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    return {
      data: page,
      next_cursor: hasMore && page.length > 0 ? Buffer.from(page[page.length - 1]!.created_at.toISOString()).toString('base64url') : null,
      has_more: hasMore,
    };
  }
}
