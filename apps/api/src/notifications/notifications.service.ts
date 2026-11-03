import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { cursorTimestampSql, encodeKeysetCursor, keysetCondition } from '../activity/keyset-cursor';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, comments, databases, memberships, notifications, records, user, userPreferences } from '../db/schema';
import { DEFAULT_PREFERENCES, mergePreferences } from '../users/preferences.constants';
import type { UserPreferences } from '../users/preferences.constants';
import { AccessService } from '../access/access.service';
import { parseEventOrigin } from '../common/credential-context';
import type { EventOrigin } from '../common/credential-context';
import { presentEventOrigins } from '../common/describe-origin';
import type { PresentedOrigin } from '../common/describe-origin';
import type { Membership } from '../workspaces/workspace-access.guard';

export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'commented'
  | 'state_changed'
  /**
   * #236 — a record you WATCH changed (any field), sent to its watchers who
   * aren't the actor. Opt-out-able like the other "something happened" pings
   * (it has a `record_changed` toggle in DEFAULT_PREFERENCES.notifications).
   */
  | 'record_changed'
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
  | 'automation_disabled'
  /**
   * MN-255 — a `require_approval` automation action is waiting on a human in
   * the Inbox before it runs. Deliberately distinct from `approval_requested`
   * (#210's agent-run gate): that type's Inbox card treats `recordId` AS the
   * thing being approved (a Run record) and posts straight to
   * `/agents/runs/{id}/approve`. Here `recordId` is the arbitrary TRIGGERING
   * record (for context/linking) and the approvable entity is a separate
   * `approvals` row — carried in `refId`, not `recordId` — so the two gates
   * can't be confused for one another in the Inbox. Not an opt-out ping, same
   * reasoning as `approval_requested`: it's a gate a run is blocked on.
   */
  | 'action_approval_requested'
  /**
   * MN-256 — a workspace hit its plan's send_email daily cap. Sent to the
   * firing rule's owner (`ctx.actorId`, best available "who to tell" without
   * a dedicated billing-contact concept); not an opt-out ping, same reasoning
   * as `automation_disabled` — it's the thing that explains why mail silently
   * stopped going out today. send-email.action.ts dedupes this itself to
   * once/24h (a manual check, not this service's own 60s burst-collapse —
   * see its own comment for why).
   */
  | 'send_email_cap_reached'
  /**
   * MN-262 — a source's own monthly run cap (e.g. Apify's `monthly_run_cap`
   * config) was reached; SourcesService.checkMonthlyCap skips scheduling
   * until next month. Sent to the source's creator only; not an opt-out
   * ping, same reasoning as `automation_disabled` — it explains why syncing
   * silently stopped. Deduped to once/calendar-month via the source's own
   * `cursor.cap_notified_month`, not this service's 60s burst-collapse.
   */
  | 'source_run_cap_reached'
  /**
   * #650 AC3 — a guest/member accepted the invite sent by `actorId`. Sent to
   * the inviter only; not an opt-out ping, same reasoning as
   * `connection_error`/`automation_disabled` — it's a one-off "this thing you
   * did completed" heads-up, not a recurring stream a user would want to mute.
   */
  | 'invite_accepted'
  /**
   * #650 AC3 — a metered usage counter (currently: non-AI automation runs)
   * crossed a warn-before-the-cap threshold this billing period. Not an
   * opt-out ping, same reasoning as `send_email_cap_reached` — it explains
   * why the workspace is about to lose a capability, not an FYI to mute.
   */
  | 'usage_threshold_reached'
  /**
   * #1131 / ADR-0021 §3 — a Runner (a person's own computer running their agents) has stopped answering, so the agents on it are
   * waiting. Bare (no record), sent once per offline episode to the owners of the agents on that Runner. Not an opt-out ping, the
   * same reasoning as `automation_disabled`: it explains why work silently stopped.
   */
  | 'runner_offline'
  /**
   * #1130 / ADR-0021 §2 — a wake lost its lease three times (the Runner stopped answering), so the agent's job failed. Bare or on the
   * record, sent once to the agent's owner. Not an opt-out ping: it explains why work silently did not happen.
   */
  | 'agent_wake_failed';

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
  /** MN-255: see NotificationType's `action_approval_requested` doc — the
   * approvable entity's own id, when it isn't `recordId`. */
  refId?: string;
  /**
   * Deliver to the actor themselves. Off by default — you don't want an inbox
   * item for your own comment. An approval request needs it on: the run acts as
   * the *agent*, so its owner must be asked even when they are the person who
   * started the run (#210).
   */
  allowSelf?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Notification stream (MN-049). Producers are best-effort: a notification
 * failure must never fail the user's action. Bursts collapse into one row
 * (same actor/recipient/type/record within a minute bumps `count`).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    let recipients = [...new Set(input.recipients)]
      .filter((r) => input.allowSelf || r !== input.actorId)
      .slice(0, 20);
    if (recipients.length === 0) return;
    recipients = await this.filterByPreference(recipients, input.type);
    if (recipients.length === 0) return;
    recipients = await this.filterByAccess(input, recipients);
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
            // An APPROVABLE entity (`refId` = an approvals row) never shares a row with another one: the
            // Inbox's Approve/Reject hang off this row's ref_id, so collapsing a burst left every older
            // approval with no handle at all (ticket #867 burst finding: five `public` proposals in a
            // minute became two rows, three approvals unreachable). Repeats of the SAME approval still
            // collapse. Everything without a refId keeps the 60s burst-collapse unchanged.
            input.refId ? eq(notifications.refId, input.refId) : undefined,
            isNull(notifications.readAt),
            gt(notifications.createdAt, new Date(Date.now() - 60_000)),
          ),
        });
        if (recent) {
          await this.db
            .update(notifications)
            .set({
              count: recent.count + 1,
              snippet: input.snippet ?? recent.snippet,
              // A row only ever collapses repeats of the SAME approvable entity (the lookup above
              // matches `refId`), so this never re-points a row away from an approval it stands for.
              refId: input.refId ?? recent.refId,
            })
            .where(eq(notifications.id, recent.id));
        } else {
          await this.db.insert(notifications).values({
            userId,
            workspaceId: input.workspaceId,
            databaseId: input.databaseId,
            recordId: input.recordId ?? null,
            actorId: input.actorId,
            type: input.type,
            refId: input.refId ?? null,
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

  /**
   * #690 — this was the one producer-side check every call site assumed
   * someone else was doing: none of comments.service.ts, records.service.ts,
   * mentions.service.ts, agents.service.ts, automations/actions.service.ts,
   * send-email.action.ts, approvals.service.ts, or billing consult
   * AccessService before calling notify(). A guest (or, once #474/#565 land,
   * a restricted member) with NO grant on the triggering database still got
   * notified and had the mentioning text stored as `snippet`, readable
   * forever via GET /notifications regardless of whether their access to the
   * source is ever granted.
   *
   * Fails CLOSED on error, unlike filterByPreference's fail-open: a
   * preference check failing just means an opt-out courtesy didn't apply,
   * but an access check failing here is exactly the leak this exists to
   * close — silently delivering anyway would defeat the whole point.
   *
   * A bare notification (no databaseId — trial reminders, connection
   * errors) has nothing to check access against and is left alone.
   */
  private filterByAccess(input: NotifyInput, recipients: string[]): Promise<string[]> {
    return this.readableRecipients(input.workspaceId, input.databaseId, input.recordId, recipients);
  }

  /**
   * Who of `recipients` can CURRENTLY read this record (or database). The one check shared by the in-app emit above and the
   * delivery paths that carry text out of the app (watcher email, mention email) — #880: they must ask at SEND time, because
   * a watcher or mentioned person may have lost access since they subscribed. No databaseId = a bare notification, left alone.
   */
  async readableRecipients(workspaceId: string, databaseId: string | undefined, recordId: string | undefined, recipients: string[]): Promise<string[]> {
    if (!databaseId) return recipients;
    const input = { workspaceId, databaseId, recordId };
    try {
      const database = await this.db.query.databases.findFirst({
        where: eq(databases.id, input.databaseId),
        columns: { id: true, spaceId: true },
      });
      if (!database) return [];
      const memberRows = await this.db.query.memberships.findMany({
        where: and(eq(memberships.workspaceId, input.workspaceId), inArray(memberships.userId, recipients)),
      });
      const membershipByUser = new Map(memberRows.map((m) => [m.userId, m]));
      const allowed: string[] = [];
      for (const userId of recipients) {
        const membership = membershipByUser.get(userId);
        if (!membership) continue;
        const effective = input.recordId
          ? await this.access.effectiveForRecord(membership, {
              id: input.recordId,
              databaseId: database.id,
              spaceId: database.spaceId,
            })
          : await this.access.effectiveForDatabase(membership, database);
        if (effective) allowed.push(userId);
      }
      return allowed;
    } catch (error) {
      this.logger.warn(`notification access check failed, dropping all recipients: ${String(error)}`);
      return [];
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

  /**
   * #880 — the rows of `rows` this caller can CURRENTLY read. Keep-and-filter (Otto, 2026-10-14): nothing is rewritten or purged,
   * so a restored grant brings the notification back. A bare notification (no database) is the caller's own and always shown.
   * Anyone nothing is closed to (an admin; a member in a workspace that restricts nothing) skips this entirely.
   */
  private async readableRows<T extends { databaseId: string | null; recordId: string | null }>(membership: Membership, rows: T[]): Promise<T[]> {
    if (!(await this.access.isNarrowed(membership))) return rows;
    const dbIds = [...new Set(rows.map((r) => r.databaseId).filter((v): v is string => Boolean(v)))];
    if (dbIds.length === 0) return rows;
    const dbRows = await this.db.query.databases.findMany({ where: inArray(databases.id, dbIds), columns: { id: true, spaceId: true } });
    const dbById = new Map(dbRows.map((d) => [d.id, d]));
    const byDatabase = await this.access.effectiveForDatabases(membership, dbRows);
    const withRecord = rows.filter((r) => r.databaseId && r.recordId && dbById.has(r.databaseId));
    const byRecord = withRecord.length
      ? await this.access.effectiveForRecords(
          membership,
          [...new Map(withRecord.map((r) => [r.recordId!, { id: r.recordId!, databaseId: r.databaseId!, spaceId: dbById.get(r.databaseId!)!.spaceId }])).values()],
        )
      : new Map<string, unknown>();
    return rows.filter((r) => {
      if (!r.databaseId) return true;
      if (!dbById.has(r.databaseId)) return false; // its database is gone: nothing to read it through
      return r.recordId ? Boolean(byRecord.get(r.recordId)) : Boolean(byDatabase.get(r.databaseId));
    });
  }

  async list(
    membership: Membership,
    userId: string,
    unreadOnly: boolean,
    cursor?: string,
    opts?: { type?: NotificationType; archived?: boolean },
  ) {
    const workspaceId = membership.workspaceId;
    const PAGE = 30;
    const narrowed = await this.access.isNarrowed(membership);
    // A narrowed reader's page is filled by scanning forward past rows they cannot read (bounded), so a run of hidden
    // notifications never turns into an empty page that looks like "no more".
    let rows: Awaited<ReturnType<NotificationsService['page']>> = [];
    let from = cursor;
    let more = false;
    for (let scan = 0; scan < (narrowed ? 10 : 1); scan++) {
      const batch = await this.page(workspaceId, userId, unreadOnly, from, opts, PAGE);
      const readable = narrowed ? await this.readableRows(membership, batch) : batch;
      rows = rows.concat(readable);
      more = batch.length === PAGE;
      if (batch.length > 0) from = encodeKeysetCursor({ t: batch[batch.length - 1]!.cursorTs, id: batch[batch.length - 1]!.id });
      if (rows.length >= PAGE || !more) break;
    }
    if (rows.length > PAGE) {
      rows = rows.slice(0, PAGE);
      more = true;
      from = encodeKeysetCursor({ t: rows[PAGE - 1]!.cursorTs, id: rows[PAGE - 1]!.id });
    }
    return this.shape(rows, more ? from! : null);
  }

  private async page(workspaceId: string, userId: string, unreadOnly: boolean, cursor: string | undefined, opts: { type?: NotificationType; archived?: boolean } | undefined, limit: number) {
    return this.db
      .select({ ...getTableColumns(notifications), cursorTs: cursorTimestampSql(notifications.createdAt) })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          unreadOnly ? isNull(notifications.readAt) : undefined,
          // Archived notifications only show in the archived view (MN-073).
          opts?.archived ? isNotNull(notifications.archivedAt) : isNull(notifications.archivedAt),
          opts?.type ? eq(notifications.type, opts.type) : undefined,
          // #851 — (created_at, id), not created_at alone. This cursor used to be a raw ISO string
          // (milliseconds), so notifications written in one statement, or within one millisecond,
          // were skipped at a page boundary. A pre-change raw-ISO cursor is still accepted.
          keysetCondition(notifications.createdAt, notifications.id, cursor, true),
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
  }

  /** #1179 — approval id -> the agent and run behind it, for the approval notifications on this page (one query for the page). */
  private async causedByForApprovals(rows: Array<{ type: string; refId: string | null }>): Promise<Map<string, PresentedOrigin>> {
    const ids = [...new Set(rows.filter((r) => (r.type === 'action_approval_requested' || r.type === 'approval_requested') && r.refId && UUID_RE.test(r.refId)).map((r) => r.refId as string))];
    const out = new Map<string, PresentedOrigin>();
    if (ids.length === 0) return out;
    const found = await this.db.select({ id: approvals.id, snapshot: approvals.actionSnapshot }).from(approvals).where(inArray(approvals.id, ids));
    const withOrigin = found.map((a) => ({ id: a.id, origin: parseEventOrigin((a.snapshot as { ctx?: { origin?: unknown } } | null)?.ctx?.origin) })).filter((a): a is { id: string; origin: EventOrigin } => a.origin !== null);
    const presented = await presentEventOrigins(this.db, withOrigin.map((a) => a.origin));
    withOrigin.forEach((a, i) => out.set(a.id, presented[i]!));
    return out;
  }

  private async shape(rows: Awaited<ReturnType<NotificationsService['page']>>, nextCursor: string | null) {
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
    const causedByApproval = await this.causedByForApprovals(rows);

    return {
      data: rows.map((n) => {
        const record = n.recordId ? recordById.get(n.recordId) : undefined;
        const actor = n.actorId ? actorById.get(n.actorId) : undefined;
        return {
          id: n.id,
          type: n.type,
          count: n.count,
          snippet: n.snippet,
          ref_id: n.refId,
          read_at: n.readAt,
          created_at: n.createdAt,
          record: record
            ? { id: record.id, title: record.title, database_id: record.databaseId, database_name: record.databaseName, deleted: Boolean(record.deletedAt) }
            : null,
          actor: actor ? { id: actor.id, name: actor.name, image: actor.image } : null,
          // #1179 — for an approval an agent's run caused: the agent and the run ('Sales assistant (run 42)'), so the Inbox row's header
          // names them instead of the rule author `actor` points at. null for every other row, and for an approval a person caused.
          caused_by: (n.refId ? causedByApproval.get(n.refId) : null) ?? null,
        };
      }),
      next_cursor: nextCursor,
    };
  }

  async unreadCount(membership: Membership, userId: string): Promise<number> {
    const workspaceId = membership.workspaceId;
    // #880 — a narrowed caller's badge counts only what the list would show. Grouped by (database, record) so the access check is
    // per distinct target, not per row.
    if (await this.access.isNarrowed(membership)) {
      const groups = await this.db
        .select({ databaseId: notifications.databaseId, recordId: notifications.recordId, n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt), isNull(notifications.archivedAt)))
        .groupBy(notifications.databaseId, notifications.recordId);
      const readable = await this.readableRows(membership, groups);
      return readable.reduce((sum, g) => sum + g.n, 0);
    }
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
