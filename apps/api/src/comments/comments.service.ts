import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, comments, databases, memberships, records, user } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionsService } from '../mentions/mentions.service';
import { PreferencesService } from '../users/preferences.service';
import { SlackService } from '../integrations/slack.service';
import { commentDeepLink, commentMentionIds, renderCommentText, truncateForPreview } from './comment-render';

// #235 — the body-shape guard now lives in the leaf render module; re-exported
// here so existing importers (`from './comments.service'`) keep working.
export { isBlocknoteCommentBody } from './comment-render';

export type CommentSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; user_id: string }
  /** #record mention (#140): the id is durable; database_id makes the chip navigable. */
  | { type: 'record'; record_id: string; database_id: string };

/**
 * Rich comment body (#180): a BlockNote document, discriminated by `format` so it
 * is unambiguously distinguishable from the legacy `CommentSegment[]` array. New
 * comments are authored in BlockNote and stored in this shape; old comments keep
 * their segment array untouched — the two coexist in the same jsonb column with
 * NO migration.
 */
export interface BlocknoteCommentBody {
  format: 'blocknote';
  doc: unknown[];
}

/** A stored comment body is EITHER the legacy segment array OR the BlockNote shape. */
export type CommentBody = CommentSegment[] | BlocknoteCommentBody;

/**
 * The @user + #record mentions a comment references, from EITHER shape (#180).
 * Delegates to the shared render module (#235) — kept as a named export for
 * existing importers.
 */
export function commentBodyMentions(body: CommentBody): { userIds: string[]; recordIds: string[] } {
  return commentMentionIds(body);
}

/**
 * Flat plain-text preview of a comment, from EITHER shape (#180). Now backed by
 * the shared `renderCommentText` (#235) so unresolved mentions read as
 * "@someone"/"#record"; pass a render context there when names are available.
 */
export function commentBodyText(body: CommentBody): string {
  return renderCommentText(body);
}

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notificationsService: NotificationsService,
    private readonly mentionsService: MentionsService,
    private readonly emailService: EmailService,
    private readonly preferences: PreferencesService,
    private readonly slackService: SlackService,
  ) {}

  /** Extracts mentions server-side and validates they are active members (D4).
   *  Accepts both body shapes (#180) — the ids are collected the same way from
   *  legacy segments or a BlockNote doc, then validated identically. */
  private async validateBody(
    workspaceId: string,
    body: CommentBody,
  ): Promise<{ mentions: string[] }> {
    const { userIds, recordIds } = commentBodyMentions(body);
    // #record mentions must point at live records in THIS workspace (#140) — a
    // stale/foreign id is refused, not stored.
    if (recordIds.length > 0) {
      const found = await this.db
        .select({ id: records.id })
        .from(records)
        .innerJoin(databases, eq(databases.id, records.databaseId))
        .where(
          and(
            inArray(records.id, recordIds),
            eq(databases.workspaceId, workspaceId),
            isNull(records.deletedAt),
          ),
        );
      if (found.length !== recordIds.length) {
        throw new UnprocessableEntityException('a mentioned record was not found in this workspace');
      }
    }

    const mentionIds = userIds;
    if (mentionIds.length === 0) return { mentions: [] };

    const rows = await this.db.query.memberships.findMany({
      where: and(
        eq(memberships.workspaceId, workspaceId),
        inArray(memberships.userId, mentionIds),
        eq(memberships.status, 'active'),
      ),
    });
    const valid = new Set(rows.filter((m) => m.role !== 'guest').map((m) => m.userId));
    const invalid = mentionIds.find((id) => !valid.has(id));
    if (invalid) {
      throw new UnprocessableEntityException(`mentioned user "${invalid}" is not a mentionable member`);
    }
    return { mentions: mentionIds };
  }

  /** #140: comments feed record backlinks — resync after any comment write. Best-effort. */
  private resyncMentions(workspaceId: string, recordId: string, actorId: string): void {
    void this.db.query.records
      .findFirst({ where: eq(records.id, recordId), columns: { databaseId: true } })
      .then((r) =>
        r
          ? this.mentionsService.syncRecordMentions(workspaceId, r.databaseId, recordId, actorId, {
              notify: false, // comments notify their own @mentions
            })
          : undefined,
      )
      .catch(() => undefined);
  }

  async list(recordId: string, limit = 100) {
    const rows = await this.db.query.comments.findMany({
      where: and(eq(comments.recordId, recordId), isNull(comments.deletedAt)),
      orderBy: [desc(comments.createdAt)],
      limit,
    });
    const authors = rows.length
      ? await this.db.query.user.findMany({
          where: inArray(user.id, [...new Set(rows.map((c) => c.authorId))]),
        })
      : [];
    const byId = new Map(authors.map((a) => [a.id, a]));
    return {
      data: rows.map((c) => ({
        id: c.id,
        body: c.body,
        author: {
          id: c.authorId,
          name: byId.get(c.authorId)?.name ?? '(deactivated)',
          image: byId.get(c.authorId)?.image ?? null,
        },
        edited_at: c.editedAt,
        created_at: c.createdAt,
      })),
    };
  }

  async create(
    workspaceId: string,
    recordId: string,
    body: CommentBody,
    authorId: string,
    source: ChangeSource = 'human',
  ) {
    const { mentions } = await this.validateBody(workspaceId, body);

    const created = await this.db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(comments)
        .values({ recordId, authorId, body, mentions })
        .returning();
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId: authorId,
        type: 'comment.created',
        payload: { comment_id: comment!.id },
        source,
      });
      return comment!;
    });

    // #235 — resolve the mentioned users' names ONCE, then render the comment a
    // single time so email, inbox, and any future channel show identical text
    // with readable "@Name" mentions instead of a bare "@…".
    const mentionedUsers = mentions.length
      ? await this.db.query.user.findMany({
          where: inArray(user.id, mentions),
          columns: { id: true, name: true, email: true },
        })
      : [];
    const userNames = new Map(mentionedUsers.map((u) => [u.id, u.name ?? 'someone']));
    const rendered = renderCommentText(body, { userNames });
    // MN-049: in-app notifications — mentions first, then the rest of the thread.
    const snippet = truncateForPreview(rendered, 120);
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (mentions.length > 0) {
      await this.notifyMentions(workspaceId, recordId, authorId, created.id, mentionedUsers, rendered);
      await this.notificationsService.notify({
        workspaceId,
        databaseId: record?.databaseId,
        recordId,
        actorId: authorId,
        type: 'mentioned',
        recipients: mentions,
        snippet,
      });
    }
    const participants = (await this.notificationsService.threadParticipants(recordId)).filter(
      (id) => !mentions.includes(id),
    );
    await this.notificationsService.notify({
      workspaceId,
      databaseId: record?.databaseId,
      recordId,
      actorId: authorId,
      type: 'commented',
      recipients: participants,
      snippet,
    });
    this.resyncMentions(workspaceId, recordId, authorId);
    return { id: created.id, body: created.body, created_at: created.createdAt };
  }

  private async notifyMentions(
    workspaceId: string,
    recordId: string,
    authorId: string,
    commentId: string,
    /** Already-loaded mentioned users (name for the shared render, email to send to). */
    mentioned: Array<{ id: string; name: string | null; email: string }>,
    /** The comment rendered once by the caller (#235) — email truncates the same
     * string the inbox snippet came from, so the two channels never diverge. */
    rendered: string,
  ) {
    const [record, author, prefs] = await Promise.all([
      this.db.query.records.findFirst({ where: eq(records.id, recordId) }),
      this.db.query.user.findFirst({ where: eq(user.id, authorId) }),
      this.preferences.notificationPrefsFor(mentioned.map((m) => m.id)),
    ]);
    const excerpt = truncateForPreview(rendered, 200);
    for (const target of mentioned) {
      if (target.id === authorId) continue;
      // MN-103: the same "Mentions" toggle that gates the in-app notification
      // (NotificationsService.filterByPreference) doubles as the v1 email
      // opt-out — no separate unsubscribe flag/table needed for this ticket.
      if (prefs.get(target.id)?.mentioned === false) continue;
      await this.emailService.send(
        {
          kind: 'mention',
          to: target.email,
          actorName: author?.name ?? 'Someone',
          recordTitle: record?.title ?? 'a record',
          excerpt,
          url: commentDeepLink(env().WEB_URL, recordId, commentId),
        },
        workspaceId, // MN-194 — attributes this send's cost to the mentioning workspace
      );
    }

    // #268 — mirror the mention to the workspace's default Slack channel (channel
    // v1; per-user DM is blocked on Slack phase-2). Reuses the SAME shared render
    // as email/inbox. Best-effort: sendMessage throws when Slack isn't connected,
    // and we swallow it — a comment must never fail because Slack is down/unset.
    const slackText =
      `💬 *${author?.name ?? 'Someone'}* mentioned you on *${record?.title ?? 'a record'}*\n` +
      `> ${excerpt}\n<${commentDeepLink(env().WEB_URL, recordId, commentId)}|Open in StoryOS>`;
    await this.slackService.sendMessage(workspaceId, { text: slackText }).catch(() => undefined);
  }

  async update(recordId: string, commentId: string, body: CommentBody, actorId: string, workspaceId: string) {
    const comment = await this.getLive(recordId, commentId);
    if (comment.authorId !== actorId) throw new ForbiddenException('Only the author can edit a comment');
    const { mentions } = await this.validateBody(workspaceId, body);
    const [updated] = await this.db
      .update(comments)
      .set({ body, mentions, editedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();
    this.resyncMentions(workspaceId, recordId, actorId);
    return { id: updated!.id, body: updated!.body, edited_at: updated!.editedAt };
  }

  async remove(recordId: string, commentId: string, actorId: string, isAdmin: boolean, workspaceId?: string) {
    const comment = await this.getLive(recordId, commentId);
    if (comment.authorId !== actorId && !isAdmin) {
      throw new ForbiddenException('Only the author or an admin can delete a comment');
    }
    await this.db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    // A deleted comment's #mentions must drop their backlinks (#140).
    if (workspaceId) this.resyncMentions(workspaceId, recordId, actorId);
    return { deleted: true };
  }

  private async getLive(recordId: string, commentId: string) {
    const comment = await this.db.query.comments.findFirst({
      where: and(eq(comments.id, commentId), eq(comments.recordId, recordId), isNull(comments.deletedAt)),
    });
    if (!comment) throw new NotFoundException('Comment not found');
    return comment;
  }
}
