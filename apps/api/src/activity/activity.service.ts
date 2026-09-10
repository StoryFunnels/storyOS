import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, comments, databases, fields, recordLinks, records, relations, user } from '../db/schema';
import { buildRenderContext, renderValue } from './render-values';
import { extractText } from '../documents/documents.service';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/** #674 — a caller-supplied chain of `N` relation fields is itself the depth
 *  bound: each level is one indexed `record_links` lookup, so cost scales
 *  with N regardless, but an unbounded array is still a footgun (a client
 *  bug pasting the same field id 500 times) worth refusing outright rather
 *  than trusting every caller to self-limit. 5 covers the ticket's own
 *  example (Epic→Story→Task, 2 hops) with real headroom. */
const MAX_HIERARCHY_DEPTH = 5;

/**
 * Read side of the activity trail (MN-027). Events are written inside every
 * mutation's transaction since MN-011; this renders them human-readable:
 * field ids → display names (deleted fields → "(deleted field)"), option ids
 * → labels, actor ids → names.
 */
@Injectable()
export class ActivityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

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
   * #670 phase 2, piece 1 — `reference.created` now included alongside
   * comments (see `MentionsService.syncRecordMentions`, which emits one row
   * per genuinely-new mention). `record_mentions` itself still carries no
   * actor/source — it stays the current-state table `backlinks()` reads —
   * these events are the append-only log of when/who/what created each one.
   *
   * Full Epic→Story→Task hierarchy aggregation (the ticket's OTHER named
   * shape) is still its own ticket — this covers one database, which is the
   * smaller, already-decided acceptance criterion ("a feed of comments/
   * references on a database"), not the hierarchy traversal.
   */
  async listCommentsForDatabase(databaseId: string, limit: number, cursor?: string) {
    return this.buildFeed(
      inArray(
        activityEvents.recordId,
        this.db.select({ id: records.id }).from(records).where(eq(records.databaseId, databaseId)),
      ),
      limit,
      cursor,
    );
  }

  /**
   * #674 — the same comment+reference feed as `listCommentsForDatabase`, but
   * scoped to an explicit, already-permission-filtered SET of record ids
   * (which may span many databases) instead of one database's subquery.
   * Shares every hydration step via `buildFeed` — a reference/comment entry
   * looks and behaves identically whether it came from one database or a
   * whole walked hierarchy.
   */
  private async listActivityForRecordIds(recordIds: string[], limit: number, cursor?: string) {
    if (recordIds.length === 0) return { data: [], next_cursor: null, has_more: false };
    return this.buildFeed(inArray(activityEvents.recordId, recordIds), limit, cursor);
  }

  /**
   * #240/#670 — the shared query+hydration core both feed methods above use.
   * `recordIdCondition` is the only thing that differs between "one
   * database's records" and "this exact set of ids" — everything downstream
   * (type filtering, comment/reference resolution, actor/record chip
   * batching, cursor pagination) is scope-agnostic.
   */
  private async buildFeed(recordIdCondition: SQL, limit: number, cursor?: string) {
    const conditions = [inArray(activityEvents.type, ['comment.created', 'reference.created']), recordIdCondition];
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
      .filter((e) => e.type === 'comment.created')
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

    // #670 — a reference's payload names the TARGET record too; resolved
    // alongside every event's own `recordId` in one batched fetch.
    const targetIds = page
      .filter((e) => e.type === 'reference.created')
      .map((e) => (e.payload as Record<string, unknown>).target_record_id)
      .filter((id): id is string => typeof id === 'string');
    const recordIds = [
      ...new Set([...page.map((e) => e.recordId).filter((id): id is string => Boolean(id)), ...targetIds]),
    ];
    const recordRows = recordIds.length
      ? await this.db.query.records.findMany({ where: inArray(records.id, recordIds), columns: { id: true, title: true, number: true } })
      : [];
    const recordById = new Map(recordRows.map((r) => [r.id, r]));
    const chipOf = (id: string | null | undefined) => {
      const r = id ? recordById.get(id) : undefined;
      return r ? { id: r.id, title: r.title, number: r.number } : null;
    };

    const actorIds = [...new Set(page.map((e) => e.actorId).filter((id): id is string => Boolean(id)))];
    const actors = actorIds.length ? await this.db.query.user.findMany({ where: inArray(user.id, actorIds) }) : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));
    const actorOf = (id: string | null) => (id ? { id, name: actorName.get(id) ?? '(deactivated)' } : null);

    return {
      data: page
        // A comment can be hard-deleted after its activity_events row was
        // written (activity_events has no FK to comments, by design — it is
        // an append-only outbox). Skip rather than show a feed entry for text
        // that no longer exists. A reference's target record can be deleted
        // too — same treatment, skip rather than show a dangling chip.
        .filter((e) => {
          const payload = e.payload as Record<string, unknown>;
          if (e.type === 'comment.created') return commentById.has(payload.comment_id as string);
          if (e.type === 'reference.created') return recordById.has(payload.target_record_id as string);
          return false;
        })
        .map((event) => {
          const payload = event.payload as Record<string, unknown>;
          if (event.type === 'reference.created') {
            return {
              id: event.id,
              type: 'reference.created' as const,
              record: chipOf(event.recordId),
              reference: { target_record: chipOf(payload.target_record_id as string) },
              actor: actorOf(event.actorId),
              created_at: event.createdAt,
              // Never defaulted to 'human' — see activity_events.source's own
              // comment. A caller must not treat a null source as a person.
              source: event.source,
            };
          }
          const comment = commentById.get(payload.comment_id as string)!;
          return {
            id: event.id,
            type: 'comment.created' as const,
            record: chipOf(event.recordId),
            comment: { id: comment.id, body: comment.body, snippet: extractText(comment.body).slice(0, 280) },
            actor: actorOf(event.actorId),
            created_at: event.createdAt,
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
   * #674 — Epic→Story→Task hierarchy aggregation, the piece #670 split off
   * as "genuinely separate, larger work". Given a root record and a caller-
   * supplied CHAIN of relation field ids (one per level — Epic's own
   * "Stories" field, then Story's own "Tasks" field, and so on; the two
   * levels are on different fields/databases, so one field cannot be
   * reused), walks the tree breadth-first and returns comments + references
   * across every record reached, permission-checked.
   *
   * Records the viewer cannot see are EXCLUDED from the aggregated set
   * before the activity query ever runs (ticket's own AC) — not fetched and
   * then redacted, which would let a filtered-out row's mere presence leak
   * through timing or count. The root itself not being visible 404s the
   * whole request (same "no existence leak" posture as a personal view: see
   * ViewsService.share's own doc comment) rather than silently returning an
   * empty feed, since an invisible ROOT means the caller had no business
   * asking about this tree at all.
   */
  async listActivityForHierarchy(
    membership: Membership,
    rootRecordId: string,
    relationFieldIds: string[],
    limit: number,
    cursor?: string,
  ) {
    if (relationFieldIds.length === 0 || relationFieldIds.length > MAX_HIERARCHY_DEPTH) {
      throw new UnprocessableEntityException(
        `relation_field_ids must name 1-${MAX_HIERARCHY_DEPTH} levels`,
      );
    }
    const [root] = await this.db
      .select({ id: records.id, databaseId: records.databaseId, spaceId: databases.spaceId })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(and(eq(records.id, rootRecordId), isNull(records.deletedAt)));
    if (!root) throw new NotFoundException('Record not found');

    // BFS: one level per supplied field id. A diamond-shaped graph (two
    // paths reaching the same descendant) is deduped by id via `seen` —
    // walked, and counted in the feed, exactly once.
    const seen = new Map<string, { id: string; databaseId: string; spaceId: string }>([[root.id, root]]);
    let frontier = [root];
    for (const fieldId of relationFieldIds) {
      if (frontier.length === 0) break;
      const next = await this.walkRelationLevel(
        frontier.map((r) => r.id),
        fieldId,
      );
      frontier = next.filter((r) => !seen.has(r.id));
      for (const r of frontier) seen.set(r.id, r);
    }

    const allRecords = [...seen.values()];
    const roles = await this.access.effectiveForRecords(membership, allRecords);
    if (!roles.get(root.id)) throw new NotFoundException('Record not found');
    const visibleIds = allRecords.filter((r) => roles.get(r.id)).map((r) => r.id);

    return this.listActivityForRecordIds(visibleIds, limit, cursor);
  }

  /**
   * One BFS level: every record on the OTHER side of `relationFieldId` from
   * any of `fromRecordIds`. Same side/column resolution `records.service.ts`
   * already uses three times over for rollups and link-writing (`side` on
   * the field's own config picks which `record_links` column is "mine" vs
   * "the other side") — reused verbatim rather than re-derived.
   *
   * A field that doesn't exist, isn't type `relation`, or is soft-deleted
   * degrades to an empty level (dangling reference, same rule every other
   * relation consumer in this codebase follows) rather than throwing — even
   * at the first level, a bad/renamed field just ends the walk at the root
   * alone, which still returns the root's own activity rather than a 422 for
   * what is, from the caller's view, "no further depth available".
   */
  private async walkRelationLevel(
    fromRecordIds: string[],
    relationFieldId: string,
  ): Promise<Array<{ id: string; databaseId: string; spaceId: string }>> {
    if (fromRecordIds.length === 0) return [];
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, relationFieldId), eq(fields.type, 'relation'), isNull(fields.deletedAt)),
    });
    if (!field) return [];
    const config = field.config as { relation_id?: string; side?: 'a' | 'b' };
    if (!config.relation_id || !config.side) return [];
    const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, config.relation_id) });
    if (!relation) return [];

    const side = config.side;
    const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

    return this.db
      .select({ id: records.id, databaseId: records.databaseId, spaceId: databases.spaceId })
      .from(recordLinks)
      .innerJoin(records, and(eq(records.id, otherCol), isNull(records.deletedAt)))
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(and(eq(recordLinks.relationId, relation.id), inArray(myCol, fromRecordIds)));
  }
}
