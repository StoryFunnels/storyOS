import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, records, recordMentions } from '../db/schema';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Membership } from '../workspaces/workspace-access.guard';

export interface CollectedMentions {
  userIds: string[];
  recordIds: string[];
}

/**
 * Walk BlockNote content for mention inline nodes (MN-205). A mention is
 * `{ type: 'mention', props: { kind: 'user'|'record', id } }`. We collect the ids,
 * deduped — the durable reference is the id, never the rendered name.
 */
export function collectMentions(content: unknown): CollectedMentions {
  const userIds = new Set<string>();
  const recordIds = new Set<string>();
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'mention' && obj.props && typeof obj.props === 'object') {
      const props = obj.props as { kind?: unknown; id?: unknown };
      if (typeof props.id === 'string' && props.id) {
        if (props.kind === 'record') recordIds.add(props.id);
        else if (props.kind === 'user') userIds.add(props.id);
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(content);
  return { userIds: [...userIds], recordIds: [...recordIds] };
}

@Injectable()
export class MentionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Reconcile the backlinks + notifications for a record's document after a save.
   * Best-effort: mention bookkeeping must never fail the document write, so callers
   * invoke this after commit and swallow errors. Replaces this source's mention set
   * wholesale (a removed #mention drops its backlink); notifies newly-@mentioned users.
   */
  async syncDocumentMentions(
    workspaceId: string,
    databaseId: string,
    sourceRecordId: string,
    content: unknown,
    actorId: string,
    snippet?: string,
  ): Promise<void> {
    const { userIds, recordIds } = collectMentions(content);

    // Keep only #targets that really exist in this workspace (ignore stale/foreign ids),
    // and never let a record backlink to itself.
    const validTargets = recordIds.length
      ? (
          await this.db
            .select({ id: records.id })
            .from(records)
            .innerJoin(databases, eq(databases.id, records.databaseId))
            .where(
              and(
                inArray(records.id, recordIds),
                eq(databases.workspaceId, workspaceId),
                isNull(records.deletedAt),
              ),
            )
        )
          .map((r) => r.id)
          .filter((id) => id !== sourceRecordId)
      : [];

    await this.db.transaction(async (tx) => {
      await tx.delete(recordMentions).where(eq(recordMentions.sourceRecordId, sourceRecordId));
      if (validTargets.length) {
        await tx
          .insert(recordMentions)
          .values(validTargets.map((targetRecordId) => ({ workspaceId, sourceRecordId, targetRecordId })))
          .onConflictDoNothing();
      }
    });

    if (userIds.length) {
      await this.notifications.notify({
        workspaceId,
        databaseId,
        recordId: sourceRecordId,
        actorId,
        type: 'mentioned',
        recipients: userIds,
        snippet,
      });
    }
  }

  /**
   * "Mentioned in": the records whose document mentions this one, scoped to what the
   * caller can actually see (a guest must not learn a title through a backlink — the
   * same leak class as MN-202). Reuses the guest-visibility grant sets.
   */
  async backlinks(membership: Membership, targetRecordId: string) {
    const visibility = await this.access.guestVisibility(membership);
    let visibleDbIds: string[] | null = null;
    if (visibility) {
      const rows = await this.db.query.databases.findMany({
        where: eq(databases.workspaceId, membership.workspaceId),
        columns: { id: true, spaceId: true },
      });
      visibleDbIds = rows
        .filter((d) => visibility.spaceIds.has(d.spaceId) || visibility.databaseIds.has(d.id))
        .map((d) => d.id);
      if (visibleDbIds.length === 0) return { data: [] };
    }

    const rows = await this.db
      .select({
        id: records.id,
        title: records.title,
        number: records.number,
        database_id: records.databaseId,
        database_name: databases.name,
      })
      .from(recordMentions)
      .innerJoin(records, eq(records.id, recordMentions.sourceRecordId))
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(
        and(
          eq(recordMentions.targetRecordId, targetRecordId),
          eq(recordMentions.workspaceId, membership.workspaceId),
          isNull(records.deletedAt),
          ...(visibleDbIds !== null ? [inArray(records.databaseId, visibleDbIds)] : []),
        ),
      )
      .orderBy(desc(recordMentions.createdAt))
      .limit(100);

    return { data: rows };
  }
}
