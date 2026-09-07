import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { portalAccessLog, portalRecipients, views } from '../db/schema';
import type { PortalAccessOutcome } from '@storyos/schemas';

/**
 * #537 — "what each client actually saw and did". Two responsibilities, kept
 * on one service because they share the table: `record()` is the write side
 * every portal-recipient access goes through, `list()` is the admin-facing
 * read side.
 */
@Injectable()
export class PortalActivityService {
  private readonly logger = new Logger(PortalActivityService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * MUST KEEP WORKING (#537's own AC): a logging failure must never block a
   * portal render. Never throws — a write error is visible to us (a warning
   * log), never to the recipient, who still sees their content either way.
   *
   * Only called for an access that resolved to a REAL, known recipient row
   * (see PublicViewsService) — an unattributable attempt (a garbage or
   * revoked token, which `resolveByToken` can't distinguish from "no such
   * recipient") has no `recipientId` to log against, since this table's
   * whole point is "attributed to recipient". That is a deliberate scoping
   * decision, not a gap: the AC asks for what each client saw and did, not a
   * generic hit log of unidentifiable public requests.
   */
  async record(entry: {
    workspaceId: string;
    recipientId: string;
    viewId: string;
    outcome: PortalAccessOutcome;
    reason?: string | null;
  }): Promise<void> {
    try {
      await this.db.insert(portalAccessLog).values({
        workspaceId: entry.workspaceId,
        recipientId: entry.recipientId,
        viewId: entry.viewId,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
      });
    } catch (error) {
      this.logger.warn(`Portal access log write failed (recipient ${entry.recipientId}): ${String(error)}`);
    }
  }

  /**
   * Admin-facing read: filterable by recipient and/or view (#537 AC — "queryable
   * per recipient and per published view"). `recipient_label`/`view_name` are
   * resolved live, never denormalized onto the row, so a rename shows up
   * immediately; `view_name` falls back to "(deleted view)" — `viewId` carries
   * no FK (see schema.ts's own comment), mirroring #454's audit log's
   * "(deleted field)" fallback for the identical reason.
   */
  async list(
    workspaceId: string,
    filter: { recipient?: string; view?: string; limit?: number; cursor?: string },
  ) {
    const limit = filter.limit ?? 50;
    const conditions = [eq(portalAccessLog.workspaceId, workspaceId)];
    if (filter.recipient) conditions.push(eq(portalAccessLog.recipientId, filter.recipient));
    if (filter.view) conditions.push(eq(portalAccessLog.viewId, filter.view));
    if (filter.cursor) {
      const created = new Date(Buffer.from(filter.cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(portalAccessLog.createdAt, created));
    }

    const rows = await this.db.query.portalAccessLog.findMany({
      where: and(...conditions),
      orderBy: [desc(portalAccessLog.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const recipientIds = [...new Set(page.map((r) => r.recipientId))];
    const viewIds = [...new Set(page.map((r) => r.viewId))];
    const [recipientRows, viewRows] = await Promise.all([
      recipientIds.length
        ? this.db.query.portalRecipients.findMany({ where: inArray(portalRecipients.id, recipientIds) })
        : Promise.resolve([]),
      viewIds.length ? this.db.query.views.findMany({ where: inArray(views.id, viewIds) }) : Promise.resolve([]),
    ]);
    const recipientLabel = new Map(recipientRows.map((r) => [r.id, r.label]));
    const viewName = new Map(viewRows.map((v) => [v.id, v.name]));

    const data = page.map((r) => ({
      id: r.id,
      recipient_id: r.recipientId,
      recipient_label: recipientLabel.get(r.recipientId) ?? '(unknown recipient)',
      view_id: r.viewId,
      view_name: viewName.get(r.viewId) ?? '(deleted view)',
      outcome: r.outcome,
      reason: r.reason,
      created_at: r.createdAt,
    }));

    return {
      data,
      next_cursor: hasMore && page.length > 0 ? Buffer.from(page[page.length - 1]!.createdAt.toISOString()).toString('base64url') : null,
      has_more: hasMore,
    };
  }
}
