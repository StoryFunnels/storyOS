import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { comments, databases, documents, fields, records, recordMentions } from '../db/schema';
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
   * Reconcile the backlinks + notifications for EVERYTHING a record says (#140):
   * its document, its rich_text field values, and its comments' #record segments.
   * One method owns the whole mention set so the three surfaces never clobber each
   * other's backlinks. Best-effort: callers invoke after commit and swallow errors.
   *
   * @user notifications come from the BlockNote surfaces only (doc + fields) —
   * comments already notify their own mentions on create. Pass notify: false when
   * the trigger was a comment write so a comment doesn't re-ping doc mentions.
   */
  async syncRecordMentions(
    workspaceId: string,
    databaseId: string,
    sourceRecordId: string,
    actorId: string,
    opts: { snippet?: string; notify?: boolean } = {},
  ): Promise<void> {
    const [doc, record, richTextFields, commentRows] = await Promise.all([
      this.db.query.documents.findFirst({ where: eq(documents.recordId, sourceRecordId) }),
      this.db.query.records.findFirst({ where: eq(records.id, sourceRecordId) }),
      this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, databaseId), eq(fields.type, 'rich_text'), isNull(fields.deletedAt)),
        columns: { id: true },
      }),
      this.db.query.comments.findMany({
        where: and(eq(comments.recordId, sourceRecordId), isNull(comments.deletedAt)),
        columns: { body: true },
      }),
    ]);

    const userIds = new Set<string>();
    const recordIdSet = new Set<string>();
    const addFrom = (content: unknown) => {
      const found = collectMentions(content);
      found.userIds.forEach((id) => userIds.add(id));
      found.recordIds.forEach((id) => recordIdSet.add(id));
    };
    addFrom(doc?.content);
    const values = (record?.values ?? {}) as Record<string, unknown>;
    for (const f of richTextFields) addFrom(values[f.id]);
    // Comments carry their own segment shape ({type:'record', record_id}); only the
    // #record half feeds backlinks here — @s in comments notify via the comment path.
    for (const c of commentRows) {
      for (const seg of (c.body as Array<{ type?: string; record_id?: string }>) ?? []) {
        if (seg?.type === 'record' && seg.record_id) recordIdSet.add(seg.record_id);
      }
    }
    const recordIds = [...recordIdSet];

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

    if (userIds.size && opts.notify !== false) {
      await this.notifications.notify({
        workspaceId,
        databaseId,
        recordId: sourceRecordId,
        actorId,
        type: 'mentioned',
        recipients: [...userIds],
        snippet: opts.snippet,
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
