import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { comments, databases, notifications, records, user, userPreferences } from '../db/schema';
import { mergePreferences } from '../users/preferences.constants';

export type NotificationType = 'assigned' | 'mentioned' | 'commented' | 'state_changed';

interface NotifyInput {
  workspaceId: string;
  databaseId?: string;
  recordId: string;
  actorId: string;
  type: NotificationType;
  recipients: string[];
  snippet?: string;
}

/**
 * Notification stream (MN-049). Producers are best-effort: a notification
 * failure must never fail the user's action. Bursts collapse into one row
 * (same actor/recipient/type/record within a minute bumps `count`).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(@Inject(DB) private readonly db: Db) {}

  async notify(input: NotifyInput): Promise<void> {
    let recipients = [...new Set(input.recipients)].filter((r) => r !== input.actorId).slice(0, 20);
    if (recipients.length === 0) return;
    recipients = await this.filterByPreference(recipients, input.type);
    if (recipients.length === 0) return;
    try {
      for (const userId of recipients) {
        const recent = await this.db.query.notifications.findFirst({
          where: and(
            eq(notifications.userId, userId),
            eq(notifications.workspaceId, input.workspaceId),
            eq(notifications.type, input.type),
            eq(notifications.recordId, input.recordId),
            input.actorId ? eq(notifications.actorId, input.actorId) : undefined,
            isNull(notifications.readAt),
            gt(notifications.createdAt, new Date(Date.now() - 60_000)),
          ),
        });
        if (recent) {
          await this.db
            .update(notifications)
            .set({ count: recent.count + 1, snippet: input.snippet ?? recent.snippet })
            .where(eq(notifications.id, recent.id));
        } else {
          await this.db.insert(notifications).values({
            userId,
            workspaceId: input.workspaceId,
            databaseId: input.databaseId,
            recordId: input.recordId,
            actorId: input.actorId,
            type: input.type,
            snippet: input.snippet,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`notification write failed: ${String(error)}`);
    }
  }

  /** Drop recipients who've turned this notification type off (#31). Defaults to on,
   * so a user with no saved preferences still gets everything. Best-effort. */
  private async filterByPreference(recipients: string[], type: NotificationType): Promise<string[]> {
    try {
      const rows = await this.db.query.userPreferences.findMany({
        where: inArray(userPreferences.userId, recipients),
      });
      const stored = new Map(rows.map((r) => [r.userId, r.preferences]));
      return recipients.filter((id) =>
        stored.has(id) ? mergePreferences(stored.get(id)).notifications[type] : true,
      );
    } catch (error) {
      this.logger.warn(`preference read failed, delivering anyway: ${String(error)}`);
      return recipients;
    }
  }

  /** Everyone in the record's comment thread + its creator (for `commented`). */
  async threadParticipants(recordId: string): Promise<string[]> {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    const thread = await this.db.query.comments.findMany({
      where: and(eq(comments.recordId, recordId), isNull(comments.deletedAt)),
      columns: { authorId: true },
    });
    const out = new Set<string>(thread.map((c) => c.authorId));
    if (record?.createdBy) out.add(record.createdBy);
    return [...out];
  }

  async list(
    workspaceId: string,
    userId: string,
    unreadOnly: boolean,
    cursor?: string,
    opts?: { type?: NotificationType; archived?: boolean },
  ) {
    const rows = await this.db.query.notifications.findMany({
      where: and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.userId, userId),
        unreadOnly ? isNull(notifications.readAt) : undefined,
        // Archived notifications only show in the archived view (MN-073).
        opts?.archived ? isNotNull(notifications.archivedAt) : isNull(notifications.archivedAt),
        opts?.type ? eq(notifications.type, opts.type) : undefined,
        cursor ? lt(notifications.createdAt, new Date(cursor)) : undefined,
      ),
      orderBy: [desc(notifications.createdAt)],
      limit: 30,
    });

    const recordIds = [...new Set(rows.map((r) => r.recordId).filter((v): v is string => Boolean(v)))];
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => Boolean(v)))];
    const [recordRows, actorRows] = await Promise.all([
      recordIds.length
        ? this.db
            .select({ id: records.id, title: records.title, databaseId: records.databaseId, databaseName: databases.name, deletedAt: records.deletedAt })
            .from(records)
            .innerJoin(databases, eq(databases.id, records.databaseId))
            .where(inArray(records.id, recordIds))
        : [],
      actorIds.length ? this.db.query.user.findMany({ where: inArray(user.id, actorIds) }) : [],
    ]);
    const recordById = new Map(recordRows.map((r) => [r.id, r]));
    const actorById = new Map(actorRows.map((a) => [a.id, a]));

    return {
      data: rows.map((n) => {
        const record = n.recordId ? recordById.get(n.recordId) : undefined;
        const actor = n.actorId ? actorById.get(n.actorId) : undefined;
        return {
          id: n.id,
          type: n.type,
          count: n.count,
          snippet: n.snippet,
          read_at: n.readAt,
          created_at: n.createdAt,
          record: record
            ? { id: record.id, title: record.title, database_id: record.databaseId, database_name: record.databaseName, deleted: Boolean(record.deletedAt) }
            : null,
          actor: actor ? { id: actor.id, name: actor.name, image: actor.image } : null,
        };
      }),
      next_cursor: rows.length === 30 ? rows[rows.length - 1]!.createdAt.toISOString() : null,
    };
  }

  async unreadCount(workspaceId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          isNull(notifications.archivedAt),
        ),
      );
    return row?.count ?? 0;
  }

  async markRead(userId: string, notificationId: string) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
    return { read: true };
  }

  /** Archive (or restore) a notification — moves it out of the default inbox (MN-073). */
  async setArchived(userId: string, notificationId: string, archived: boolean) {
    await this.db
      .update(notifications)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
    return { archived };
  }

  async markAllRead(workspaceId: string, userId: string) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      );
    return { read: true };
  }
}
