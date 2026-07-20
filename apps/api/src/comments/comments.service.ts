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
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionsService } from '../mentions/mentions.service';
import { PreferencesService } from '../users/preferences.service';

export type CommentSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; user_id: string }
  /** #record mention (#140): the id is durable; database_id makes the chip navigable. */
  | { type: 'record'; record_id: string; database_id: string };

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notificationsService: NotificationsService,
    private readonly mentionsService: MentionsService,
    private readonly emailService: EmailService,
    private readonly preferences: PreferencesService,
  ) {}

  /** Extracts mentions server-side and validates they are active members (D4). */
  private async validateBody(
    workspaceId: string,
    body: CommentSegment[],
  ): Promise<{ mentions: string[] }> {
    // #record segments must point at live records in THIS workspace (#140) — a
    // stale/foreign id is refused, not stored.
    const recordIds = [
      ...new Set(body.filter((s) => s.type === 'record').map((s) => (s as { record_id: string }).record_id)),
    ];
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

    const mentionIds = [...new Set(body.filter((s) => s.type === 'mention').map((s) => (s as { user_id: string }).user_id))];
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
    body: CommentSegment[],
    authorId: string,
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
      });
      return comment!;
    });

    if (mentions.length > 0) await this.notifyMentions(workspaceId, recordId, authorId, mentions, body);

    // MN-049: in-app notifications — mentions first, then the rest of the thread.
    const snippet = body
      .map((s) => (s.type === 'text' ? s.text : '@…'))
      .join('')
      .slice(0, 120);
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (mentions.length > 0) {
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
    mentionIds: string[],
    body: CommentSegment[],
  ) {
    const [record, author, mentioned, prefs] = await Promise.all([
      this.db.query.records.findFirst({ where: eq(records.id, recordId) }),
      this.db.query.user.findFirst({ where: eq(user.id, authorId) }),
      this.db.query.user.findMany({ where: inArray(user.id, mentionIds) }),
      this.preferences.notificationPrefsFor(mentionIds),
    ]);
    const excerpt = body
      .map((s) => (s.type === 'text' ? s.text : '@…'))
      .join('')
      .slice(0, 200);
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
          url: `${env().WEB_URL}/r/${recordId}`,
        },
        workspaceId, // MN-194 — attributes this send's cost to the mentioning workspace
      );
    }
  }

  async update(recordId: string, commentId: string, body: CommentSegment[], actorId: string, workspaceId: string) {
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
