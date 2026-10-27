import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { comments, linearCommentPushes, user } from '../db/schema';
import { env } from '../config/env';
import { MAX_ATTEMPTS, nextAttemptDelayMs } from '../common/backoff-schedule';
import { CommentsService, commentBodyMentions } from '../comments/comments.service';
import type { CommentBody } from '../comments/comments.service';
import { renderCommentText } from '../comments/comment-render';
import { NotificationsService } from '../notifications/notifications.service';
import { LinearService } from './linear.service';

/** The one Linear mutation this service ever sends. A test asserts nothing else is (no issue field is ever written). */
export const COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`;

/**
 * #1102 — a read of ONE issue's comments, used only to find a comment of ours that Linear already holds. Read-only; the
 * mutation above is still the only write. Filtered by issue (the same filter shape the importer's team query uses) and
 * matched on the marker client-side, so a filter Linear ignores can only cost pages, never a missed match.
 */
export const ISSUE_COMMENTS_QUERY = `query IssueComments($id: ID!, $after: String) { comments(first: 100, after: $after, filter: { issue: { id: { eq: $id } } }) { nodes { id body url } pageInfo { hasNextPage endCursor } } }`;

/**
 * #1102 — the idempotency marker: the last line of every pushed comment names the StoryOS comment it came from. A send
 * can reach Linear and the "sent" record still be lost (crash, dropped response), so "did this already go out?" is
 * answered by asking Linear, not by our own bookkeeping. The first line (the signature the importer keys on) is untouched.
 */
export const pushMarker = (commentId: string) => `storyos-comment-${commentId}`;

/** What closes the first line of every pushed comment. The importer treats it as proof a Linear comment came from us. */
export const VIA_STORYOS = '· via StoryOS';

/** A push stuck in `sending` this long was cut off by a crash; it is put back in the queue. */
const SENDING_TIMEOUT_MINUTES = 10;

/**
 * #907 — comments written in StoryOS on a record that mirrors a Linear issue are pushed to that issue. COMMENTS ONLY:
 * no issue field is ever written, because Linear owns them. Opt-in per workspace (`settings.linear.write_back`), and
 * only comments created AFTER it was switched on are considered, so enabling it never replays history.
 *
 * The push is server-side with the key stored for the importer; nothing here, and no MCP tool, hands that key to an
 * agent. Agents write a StoryOS comment and the server does the rest.
 *
 * Why a polled outbox (`linear_comment_pushes`) and not a hook in CommentsService: IntegrationsModule already imports
 * CollaborationModule, so a callback from comments into Linear would be a module cycle, and an outbox gives retry and
 * a visible failure state for free. Latency is one 60 s tick.
 *
 * The echo loop (the thing to get right): a comment we push becomes a Linear comment, and the next sync would import it
 * back as a second copy. Two independent guards in LinearService's import keep that from happening: the Linear comment
 * id is stored here and skipped, AND anything whose first line ends in "· via StoryOS" is skipped. The reverse
 * direction is closed too: an imported comment has `source = 'automation'` and is never eligible to be pushed.
 */
@Injectable()
export class LinearWriteBackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinearWriteBackService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly linear: LinearService,
    private readonly commentsService: CommentsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass — public so tests can call it. Queue new eligible comments, then send what is due. */
  async tick(now = new Date()): Promise<void> {
    const rows = (await this.db.execute(
      sql`SELECT id, settings->'linear'->'write_back'->>'enabled_at' AS enabled_at FROM workspaces WHERE settings->'linear'->'write_back'->>'enabled' = 'true'`,
    )) as unknown as { rows?: Array<{ id: string; enabled_at: string | null }> };
    for (const { id, enabled_at } of rows.rows ?? []) {
      try {
        await this.enqueueEligible(id, enabled_at ? new Date(enabled_at) : now, now);
        await this.sendDue(id, now);
      } catch (error) {
        this.logger.warn(`linear write-back for ${id} failed: ${String(error)}`);
      }
    }
  }

  /**
   * Queue comments written on a mirrored record since write-back was enabled. Eligible: not deleted, on a live record
   * whose Issues database carries a `linear_id` that is set, authored in StoryOS (never `source = 'automation'`, which
   * is what an imported comment is), and not carrying a Linear footer link. ON CONFLICT DO NOTHING: a comment is queued once.
   */
  async enqueueEligible(workspaceId: string, since: Date, now = new Date()): Promise<number> {
    const res = (await this.db.execute(sql`
      INSERT INTO linear_comment_pushes (comment_id, workspace_id, linear_issue_id, next_attempt_at)
      SELECT c.id, ${workspaceId}::uuid, r.values->>(f.id::text), ${now.toISOString()}::timestamptz
        FROM comments c
        JOIN records r ON r.id = c.record_id
        JOIN databases d ON d.id = r.database_id AND d.workspace_id = ${workspaceId}
        JOIN fields f ON f.database_id = r.database_id AND f.api_name = 'linear_id' AND f.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
         AND r.deleted_at IS NULL
         AND c.created_at > ${since.toISOString()}::timestamptz
         AND (c.source IS NULL OR c.source <> 'automation')
         AND coalesce(r.values->>(f.id::text), '') <> ''
         AND c.body::text NOT LIKE '%linear.app/%#comment-%'
      ON CONFLICT (comment_id) DO NOTHING
      RETURNING comment_id`)) as unknown as { rows?: unknown[] };
    return res.rows?.length ?? 0;
  }

  private async sendDue(workspaceId: string, now: Date): Promise<void> {
    // A push cut off mid-call (crash) goes back in the queue.
    await this.db.execute(sql`
      UPDATE linear_comment_pushes SET status = 'pending'
       WHERE workspace_id = ${workspaceId} AND status = 'sending'
         AND updated_at < ${new Date(now.getTime() - SENDING_TIMEOUT_MINUTES * 60_000).toISOString()}::timestamptz`);
    // Claim a batch atomically (safe with several API instances): the winner flips them to 'sending'.
    const claimed = (await this.db.execute(sql`
      UPDATE linear_comment_pushes SET status = 'sending', attempts = attempts + 1
       WHERE comment_id IN (
         SELECT comment_id FROM linear_comment_pushes
          WHERE workspace_id = ${workspaceId} AND status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
          ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING comment_id, linear_issue_id, attempts`)) as unknown as { rows?: Array<{ comment_id: string; linear_issue_id: string; attempts: number }> };
    for (const row of claimed.rows ?? []) {
      await this.pushOne(workspaceId, row.comment_id, row.linear_issue_id, row.attempts, now);
    }
  }

  private async pushOne(workspaceId: string, commentId: string, linearIssueId: string, attempts: number, now: Date): Promise<void> {
    try {
      const comment = await this.db.query.comments.findFirst({ where: eq(comments.id, commentId) });
      if (!comment || comment.deletedAt) {
        // Deleted before it was sent: nothing to deliver, and nothing to mark.
        await this.db.update(linearCommentPushes).set({ status: 'failed', lastError: 'comment was deleted before it was sent' }).where(eq(linearCommentPushes.commentId, commentId));
        return;
      }
      const apiKey = await this.linear.apiKeyFor(workspaceId);
      // #1102 — attempts > 1 means an earlier attempt may have reached Linear before its outcome was recorded (a crash
      // leaves the row 'sending'; a dropped response looks like a failure). Ask Linear before sending again. A lookup
      // that itself fails throws into the catch below: back off and retry, never fall through to a blind resend.
      if (attempts > 1) {
        const existing = await this.findAlreadySent(apiKey, linearIssueId, commentId);
        if (existing) {
          await this.db
            .update(linearCommentPushes)
            .set({ status: 'sent', lastError: null, linearCommentId: existing.id, linearCommentUrl: existing.url ?? null })
            .where(eq(linearCommentPushes.commentId, commentId));
          return;
        }
      }
      const text = await this.signedText(comment);
      const data = (await this.linear.fetcher(COMMENT_CREATE_MUTATION, { input: { issueId: linearIssueId, body: text } }, apiKey)) as {
        commentCreate?: { success?: boolean; comment?: { id?: string; url?: string } };
      };
      const created = data.commentCreate;
      if (!created?.success || !created.comment?.id) throw new Error('Linear did not confirm the comment was created');
      await this.db
        .update(linearCommentPushes)
        .set({ status: 'sent', lastError: null, linearCommentId: created.comment.id, linearCommentUrl: created.comment.url ?? null })
        .where(eq(linearCommentPushes.commentId, commentId));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const delay = nextAttemptDelayMs(attempts);
      if (delay !== null) {
        await this.db
          .update(linearCommentPushes)
          .set({ status: 'pending', lastError: message, nextAttemptAt: new Date(now.getTime() + delay) })
          .where(eq(linearCommentPushes.commentId, commentId));
        return;
      }
      // Out of attempts: say so ON THE COMMENT, where the person who wrote it will see it, and tell them once.
      await this.db.update(linearCommentPushes).set({ status: 'failed', lastError: message }).where(eq(linearCommentPushes.commentId, commentId));
      await this.commentsService.appendNote(commentId, `⚠ Not delivered to Linear after ${MAX_ATTEMPTS} attempts: ${message}`).catch(() => undefined);
      const comment = await this.db.query.comments.findFirst({ where: eq(comments.id, commentId), columns: { authorId: true, recordId: true } });
      if (comment) {
        await this.notifications
          .notify({ workspaceId, recordId: comment.recordId, actorId: comment.authorId, type: 'connection_error', recipients: [comment.authorId], snippet: `A comment was not delivered to Linear: ${message.slice(0, 120)}`, allowSelf: true })
          .catch(() => undefined);
      }
    }
  }

  /** #1102 — the Linear comment on this issue that carries this StoryOS comment's marker, if one is there. */
  private async findAlreadySent(apiKey: string, linearIssueId: string, commentId: string): Promise<{ id: string; url?: string } | null> {
    const marker = pushMarker(commentId);
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const data = (await this.linear.fetcher(ISSUE_COMMENTS_QUERY, after ? { id: linearIssueId, after } : { id: linearIssueId }, apiKey)) as {
        comments?: { nodes?: Array<{ id: string; body?: string | null; url?: string }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
      };
      const conn = data.comments;
      // An answer we cannot read as a complete list is NOT "not there": that reading is what would cause the duplicate.
      if (!conn || !Array.isArray(conn.nodes) || !conn.pageInfo) throw new Error('Linear returned no usable comment list, so it is unknown whether this comment was already sent');
      const hit = conn.nodes.find((n) => typeof n.body === 'string' && n.body.includes(marker));
      if (hit) return hit;
      if (!conn.pageInfo.hasNextPage) return null;
      const next = conn.pageInfo.endCursor;
      if (!next || seen.has(next)) throw new Error('Linear comment paging stopped advancing, so it is unknown whether this comment was already sent');
      seen.add(next);
      after = next;
    }
  }

  /**
   * First line = who wrote it and the route, because everything goes out through one Linear key and without this line
   * the team reads an agent's output as whoever owns the key. The agent's name when it is one, else the author's.
   */
  private async signedText(comment: typeof comments.$inferSelect): Promise<string> {
    const body = comment.body as CommentBody;
    const { userIds } = commentBodyMentions(body);
    const people = await this.db.query.user.findMany({
      where: inArray(user.id, [...new Set([comment.authorId, ...userIds])]),
      columns: { id: true, name: true },
    });
    const names = new Map(people.map((p) => [p.id, p.name ?? 'someone']));
    const author = comment.agentName ?? names.get(comment.authorId) ?? 'Someone';
    return `**${author} ${VIA_STORYOS}**\n\n${renderCommentText(body, { userNames: names })}\n\n_${pushMarker(comment.id)}_`;
  }
}
