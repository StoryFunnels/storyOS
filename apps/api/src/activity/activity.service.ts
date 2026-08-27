import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, user } from '../db/schema';
import { buildRenderContext, renderValue } from './render-values';

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
