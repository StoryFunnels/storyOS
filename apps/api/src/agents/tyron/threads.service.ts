import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { tyronMessages, tyronThreads } from '../../db/schema';
import type { Membership } from '../../workspaces/workspace-access.guard';

/**
 * Tyron threads (#359).
 *
 * Every read and write in here is scoped by `(workspaceId, ownerUserId)` — there
 * is deliberately no code path that fetches a thread by id alone.
 *
 * **There is no admin bypass, and that is the point.** #290 decided admins cannot
 * see personal content, the founder's call for threads was "all private for now",
 * and a thread is a record of someone thinking out loud. Implemented as
 * owner-scoped *lookup* rather than a lookup plus a permission check, because the
 * latter is the shape that eventually grows an `if (isAdmin)` branch. If the row
 * cannot be found without the owner's id, no future caller can accidentally widen
 * it.
 *
 * A miss raises 404, never 403 — telling someone "that thread exists but is not
 * yours" leaks the one fact privacy is meant to withhold. Same no-leak convention
 * the rest of the API follows.
 */
@Injectable()
export class TyronThreadsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Auto-name a thread from its first message (#359: nothing may be called
   * "Untitled" — a thread list reading "New chat, New chat, New chat" is one
   * nobody opens twice).
   *
   * First line only, so a pasted multi-paragraph brief becomes a title rather
   * than a wall. Collapses whitespace, trims to a readable length on a word
   * boundary where possible, and falls back to a plain default for a message
   * with no usable text (an attachment-only opener, say) — never an empty title.
   */
  static titleFrom(firstMessage: string): string {
    const firstLine = (firstMessage.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
    const collapsed = firstLine.replace(/\s+/g, ' ');
    if (!collapsed) return 'New conversation';
    const LIMIT = 60;
    if (collapsed.length <= LIMIT) return collapsed;
    const cut = collapsed.slice(0, LIMIT);
    // Prefer a word boundary, but only if it does not cost most of the title —
    // a long first "word" (a URL, an id) would otherwise truncate to almost
    // nothing.
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > LIMIT * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }

  /** The member's own threads, most recently used first. */
  async list(membership: Membership) {
    const rows = await this.db.query.tyronThreads.findMany({
      where: and(
        eq(tyronThreads.workspaceId, membership.workspaceId),
        eq(tyronThreads.ownerUserId, membership.userId),
      ),
      orderBy: [desc(tyronThreads.updatedAt)],
    });
    return { data: rows.map((t) => ({ id: t.id, title: t.title, updated_at: t.updatedAt })) };
  }

  async create(membership: Membership, firstMessage?: string) {
    const [row] = await this.db
      .insert(tyronThreads)
      .values({
        workspaceId: membership.workspaceId,
        ownerUserId: membership.userId,
        title: TyronThreadsService.titleFrom(firstMessage ?? ''),
      })
      .returning();
    return { id: row!.id, title: row!.title, updated_at: row!.updatedAt };
  }

  /**
   * The single owner-scoped lookup every other method goes through. Private on
   * purpose: nothing in this service should be able to reach a thread without
   * naming whose it is.
   */
  private async own(membership: Membership, threadId: string) {
    const row = await this.db.query.tyronThreads.findFirst({
      where: and(
        eq(tyronThreads.id, threadId),
        eq(tyronThreads.workspaceId, membership.workspaceId),
        eq(tyronThreads.ownerUserId, membership.userId),
      ),
    });
    if (!row) throw new NotFoundException('Thread not found');
    return row;
  }

  /** A thread with its history — what makes Tyron feel like a colleague who was there. */
  async get(membership: Membership, threadId: string) {
    const thread = await this.own(membership, threadId);
    const messages = await this.db.query.tyronMessages.findMany({
      where: eq(tyronMessages.threadId, thread.id),
      orderBy: [asc(tyronMessages.createdAt)],
    });
    return {
      id: thread.id,
      title: thread.title,
      updated_at: thread.updatedAt,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.createdAt,
        /*
         * `actions` is intentionally NOT returned. #357 is explicit that Tyron
         * streams outcomes and never a tool trace, and an API that hands the
         * client a structured tool log is an invitation to render one. It is
         * stored for #354 replay and our own observability, and read server-side.
         */
      })),
    };
  }

  async rename(membership: Membership, threadId: string, title: string) {
    const thread = await this.own(membership, threadId);
    const [row] = await this.db
      .update(tyronThreads)
      .set({ title })
      .where(eq(tyronThreads.id, thread.id))
      .returning();
    return { id: row!.id, title: row!.title, updated_at: row!.updatedAt };
  }

  /**
   * Delete a thread. Messages cascade.
   *
   * #359: deleting a thread does NOT undo what it did, and the UI says so before
   * deleting. Nothing is reversed here on purpose — the conversation is private
   * but its consequences are shared workspace state, and silently rolling back
   * other people's data because one person tidied their chat list would be a far
   * worse surprise than the one the confirmation warns about.
   */
  async remove(membership: Membership, threadId: string) {
    const thread = await this.own(membership, threadId);
    await this.db.delete(tyronThreads).where(eq(tyronThreads.id, thread.id));
    return { deleted: thread.id };
  }

  /**
   * Append a turn, and record what it DID as structure (#359 → #354).
   *
   * `actions` is the tool calls as data, not prose. If the only record were the
   * transcript, "do this every Monday" would mean re-deriving intent from text —
   * a rewrite, not a feature.
   *
   * Touching `updatedAt` is what keeps the thread list ordered by recency, which
   * is the order a returning user actually wants.
   */
  async appendMessage(
    membership: Membership,
    threadId: string,
    message: {
      role: 'user' | 'assistant';
      content: string;
      actions?: Array<{ name: string; arguments: Record<string, unknown> }>;
      /**
       * #357 — what the turn cost, in tokens, and which model answered.
       *
       * Measurement only: #353 decided against a spend ceiling deliberately, and
       * this exists so a future limit can be chosen from data rather than
       * guessed. Omitted on user messages and on a turn whose model call failed
       * — absent is honest there, whereas zero would read as "free".
       */
      usage?: { tokensIn: number; tokensOut: number; model: string };
    },
  ) {
    const thread = await this.own(membership, threadId);
    const [row] = await this.db
      .insert(tyronMessages)
      .values({
        threadId: thread.id,
        role: message.role,
        content: message.content,
        actions: message.actions ?? [],
        tokensIn: message.usage?.tokensIn,
        tokensOut: message.usage?.tokensOut,
        model: message.usage?.model,
      })
      .returning();
    await this.db
      .update(tyronThreads)
      .set({ updatedAt: new Date() })
      .where(eq(tyronThreads.id, thread.id));
    return { id: row!.id };
  }
}
