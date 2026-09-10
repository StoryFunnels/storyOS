import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, comments, records, user } from '../db/schema';
import { buildRenderContext, renderValue } from './render-values';
import { extractText } from '../documents/documents.service';

/**
 * Read side of the activity trail (MN-027). Events are written inside every
 * mutation's transaction since MN-011; this renders them human-readable:
 * field ids → display names (deleted fields → "(deleted field)"), option ids
 * → labels, actor ids → names.
 */
@Injectable()
export class ActivityService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listForRecord(databaseId: string, recordId: string, limit: number, cursor?: string) {
    const conditions = [eq(activityEvents.recordId, recordId)];
    if (cursor) {
      const created = new Date(Buffer.from(cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(activityEvents.createdAt, created));
    }
    const rows = await this.db.query.activityEvents.findMany({
      where: and(...conditions),
      orderBy: [desc(activityEvents.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    // Resolution context: fields (INCLUDING soft-deleted, for old diffs), options, actors.
    // Shared with listFieldChanges since #335 — the two read the SAME diff, and
    // when only this one resolved it, one change rendered two ways.
    const { fieldName, optionLabel } = await buildRenderContext(this.db, databaseId);

    const actorIds = [...new Set(page.map((e) => e.actorId).filter((id): id is string => Boolean(id)))];
    const actors = actorIds.length
      ? await this.db.query.user.findMany({ where: inArray(user.id, actorIds) })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    const resolveValue = (value: unknown): unknown => renderValue(value, { optionLabel });

    return {
      data: page.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        let changes: Array<{ field: string; from: unknown; to: unknown }> | undefined;
        if (event.type === 'record.updated' && payload.diff) {
          changes = Object.entries(payload.diff as Record<string, { from: unknown; to: unknown }>).map(
            ([fieldId, change]) => ({
              field: fieldId === 'title' ? 'Name' : (fieldName.get(fieldId) ?? '(deleted field)'),
              from: resolveValue(change.from),
              to: resolveValue(change.to),
            }),
          );
        }
        return {
          id: event.id,
          type: event.type,
          actor: event.actorId
            ? { id: event.actorId, name: actorName.get(event.actorId) ?? '(deactivated)' }
            : null,
          payload: event.payload,
          changes,
          created_at: event.createdAt,
          // #481 — null on every row written before this column existed, or on
          // a call site not yet threading a source (never defaulted to
          // 'human': see activity_events.source's own comment).
          source: event.source,
        };
      }),
      next_cursor:
        hasMore && page.length > 0
          ? Buffer.from(page[page.length - 1]!.createdAt.toISOString()).toString('base64url')
          : null,
      has_more: hasMore,
    };
  }

  /**
   * #240 phase 1 — comments across every record in ONE database, newest
   * first: "a feed of comments on the Task database as a quick overview of
   * recent work" (the ticket's own concrete example). Reads `activity_events`
   * — the same table `listForRecord` reads — filtered to `comment.created`,
   * rather than a second capture path for "a comment was written": the
   * ticket's own mechanism decision is "share the DATA, not the query
   * mechanism", and this is a different-shaped query (a time range across
   * many records) over the identical source rows.
   *
   * References (@mentions) are NOT in this feed yet — `record_mentions`
   * carries no actor/source at all, so a reference entry here could not
   * honestly answer "who/what did this" (the same NEW criterion this ticket
   * added for exactly this reason). Filed as its own ticket rather than
   * either skipping the requirement or shipping an unattributed entry.
   *
   * Full Epic→Story→Task hierarchy aggregation (the ticket's other named
   * shape) is ALSO out of this phase — this covers one database, which is
   * the smaller, already-decided acceptance criterion ("a feed of comments
   * on a database"), not the hierarchy traversal. Also its own ticket.
   */
  async listCommentsForDatabase(databaseId: string, limit: number, cursor?: string) {
    const conditions = [
      eq(activityEvents.type, 'comment.created'),
      inArray(
        activityEvents.recordId,
        this.db.select({ id: records.id }).from(records).where(eq(records.databaseId, databaseId)),
      ),
    ];
    if (cursor) {
      const created = new Date(Buffer.from(cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(activityEvents.createdAt, created));
    }
    const rows = await this.db.query.activityEvents.findMany({
      where: and(...conditions),
      orderBy: [desc(activityEvents.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const commentIds = page
      .map((e) => (e.payload as Record<string, unknown>).comment_id)
      .filter((id): id is string => typeof id === 'string');
    // isNull(deletedAt): a deleted comment is soft-deleted, not removed — the
    // row is still there for `comments.findMany` to find. Excluded here the
    // same way `commentsService.getLive` excludes it from every other read
    // path, so the feed doesn't show text its own author deleted.
    const commentRows = commentIds.length
      ? await this.db.query.comments.findMany({ where: and(inArray(comments.id, commentIds), isNull(comments.deletedAt)) })
      : [];
    const commentById = new Map(commentRows.map((c) => [c.id, c]));

    const recordIds = [...new Set(page.map((e) => e.recordId).filter((id): id is string => Boolean(id)))];
    const recordRows = recordIds.length
      ? await this.db.query.records.findMany({ where: inArray(records.id, recordIds), columns: { id: true, title: true, number: true } })
      : [];
    const recordById = new Map(recordRows.map((r) => [r.id, r]));

    const actorIds = [...new Set(page.map((e) => e.actorId).filter((id): id is string => Boolean(id)))];
    const actors = actorIds.length ? await this.db.query.user.findMany({ where: inArray(user.id, actorIds) }) : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    return {
      data: page
        // A comment can be hard-deleted after its activity_events row was
        // written (activity_events has no FK to comments, by design — it is
        // an append-only outbox). Skip rather than show a feed entry for text
        // that no longer exists.
        .filter((e) => commentById.has((e.payload as Record<string, unknown>).comment_id as string))
        .map((event) => {
          const comment = commentById.get((event.payload as Record<string, unknown>).comment_id as string)!;
          const record = event.recordId ? recordById.get(event.recordId) : undefined;
          return {
            id: event.id,
            type: 'comment.created' as const,
            record: record ? { id: record.id, title: record.title, number: record.number } : null,
            comment: { id: comment.id, body: comment.body, snippet: extractText(comment.body).slice(0, 280) },
            actor: event.actorId
              ? { id: event.actorId, name: actorName.get(event.actorId) ?? '(deactivated)' }
              : null,
            created_at: event.createdAt,
            // Never defaulted to 'human' — see activity_events.source's own
            // comment. A caller must not treat a null source as a person.
            source: event.source,
          };
        }),
      next_cursor:
        hasMore && page.length > 0
          ? Buffer.from(page[page.length - 1]!.createdAt.toISOString()).toString('base64url')
          : null,
      has_more: hasMore,
    };
  }
}
