import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { comments, databases, notifications, records, user, userPreferences } from '../db/schema';
import { DEFAULT_PREFERENCES, mergePreferences } from '../users/preferences.constants';
import type { UserPreferences } from '../users/preferences.constants';

export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'commented'
  | 'state_changed'
  /**
   * An agent run staged a gated action and is waiting on its owner (#210,
   * ADR-0010 §4). Not an opt-out ping — see OPT_OUT_TYPES.
   */
  | 'approval_requested'
  /**
   * Proactive day-23/day-29 trial-expiry heads-up (#263, TrialRemindersService).
   * Bare — no record/database behind it, see NotifyInput.recordId — and, like
   * approval_requested, not an opt-out ping: it warns a team before an
   * automatic downgrade to Free, so there is no toggle to honour here either.
   */
  | 'trial_reminder_23'
  | 'trial_reminder_29'
  /**
   * MN-252 — an OAuth2 connection's token refresh failed (no refresh_token,
   * or the provider rejected it) and its status flipped to `expired`. Sent to
   * the connection's creator only; not an opt-out ping for the same reason
   * approval_requested isn't — it's the thing that unblocks reconnecting, not
   * a "something already happened" ping the recipient might rather mute.
   */
  | 'connection_error'
  /**
   * MN-189 follow-up (#265) — an off-session auto-reload charge failed.
   * Bare, like the trial reminders above. Not an opt-out ping for the same
   * reason: it's a billing problem the workspace needs to act on (update the
   * card), not an FYI about something already handled.
   */
  | 'auto_reload_failed'
  /**
   * MN-253 — JobRunnerService auto-disabled a rule after MAX_FAILURES
   * consecutive job failures. Sent to the rule's creator only; not an
   * opt-out ping for the same reason connection_error isn't — it's the thing
   * that tells an owner their automation silently stopped running.
   */
  | 'automation_disabled';

/**
 * The types a user can switch off (#31). `notifications.type` is a plain text
 * column, so this set — not the column — is what decides whether a type is
 * gated on a preference toggle.
 *
 * Anything NOT listed here is delivered unconditionally. That is what makes an
 * approval request (#210) reliable: it is a gate the run is blocked on, not a
 * notification about something that already happened, so there is no toggle to
 * honour and silently dropping it would strand the run forever. Deriving the set
 * from DEFAULT_PREFERENCES means adding a toggle opts a type in deliberately,
 * and a type with no toggle can never be dropped by a lookup returning
 * `undefined`.
 */
const OPT_OUT_TYPES = new Set<string>(Object.keys(DEFAULT_PREFERENCES.notifications));

interface NotifyInput {
  workspaceId: string;
  databaseId?: string;
  /**
   * Absent for a bare, no-record notification — a billing/system heads-up
   * (e.g. trial_reminder_23/29) has no record or database behind it. Every
   * other producer in this codebase passes one; the dedup query and insert
   * below both treat "no recordId" as its own group (IS NULL), not a
   * wildcard, so a bare notification only collapses/dedupes against other
   * bare notifications of the same type.
   */
  recordId?: string;
  actorId: string;
  type: NotificationType;
  recipients: string[];
  snippet?: string;
  /**
   * Deliver to the actor themselves. Off by default — you don't want an inbox
   * item for your own comment. An approval request needs it on: the run acts as
   * the *agent*, so its owner must be asked even when they are the person who
   * started the run (#210).
   */
  allowSelf?: boolean;
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
    let recipients = [...new Set(input.recipients)]
      .filter((r) => input.allowSelf || r !== input.actorId)
      .slice(0, 20);
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
            input.recordId ? eq(notifications.recordId, input.recordId) : isNull(notifications.recordId),
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
            recordId: input.recordId ?? null,
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
    // A type with no toggle isn't opt-out-able — deliver it (#210). Without this
    // the lookup below would return `undefined` for it and drop every recipient
    // who has ever saved a preference.
    if (!OPT_OUT_TYPES.has(type)) return recipients;
    try {
      const rows = await this.db.query.userPreferences.findMany({
        where: inArray(userPreferences.userId, recipients),
      });
      const stored = new Map(rows.map((r) => [r.userId, r.preferences]));
      // Safe: OPT_OUT_TYPES is exactly the keys of the toggle map, and anything
      // outside it returned above.
      const toggle = type as keyof UserPreferences['notifications'];
      return recipients.filter((id) =>
        stored.has(id) ? mergePreferences(stored.get(id)).notifications[toggle] : true,
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
