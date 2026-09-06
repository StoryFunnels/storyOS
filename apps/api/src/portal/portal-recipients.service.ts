import { randomBytes } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { portalRecipients } from '../db/schema';
import type { CreatePortalRecipientInput } from '@storyos/schemas';

/**
 * #534 — identity and lifecycle for a portal recipient. Deliberately does NOT
 * scope which rows a recipient can read (filed separately) — this is the
 * entity itself: create, list, count, revoke, and resolve-by-token.
 */
@Injectable()
export class PortalRecipientsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(workspaceId: string, input: CreatePortalRecipientInput) {
    // #534 AC3 — server-generated, opaque, never derived from label/id/time.
    const token = randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(portalRecipients)
      .values({ workspaceId, label: input.label, email: input.email ?? null, token })
      .returning();
    return row!;
  }

  async list(workspaceId: string) {
    return this.db.query.portalRecipients.findMany({
      where: eq(portalRecipients.workspaceId, workspaceId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  async count(workspaceId: string) {
    const rows = await this.list(workspaceId);
    return rows.length;
  }

  async revoke(workspaceId: string, recipientId: string) {
    const row = await this.db.query.portalRecipients.findFirst({
      where: and(eq(portalRecipients.id, recipientId), eq(portalRecipients.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('recipient not found');
    const [updated] = await this.db
      .update(portalRecipients)
      .set({ revokedAt: new Date() })
      .where(eq(portalRecipients.id, recipientId))
      .returning();
    return updated!;
  }

  /**
   * The only consumer-facing check this ticket ships: resolves a bearer token
   * to its live recipient row, straight from the database on every call — no
   * cache, no session, nothing that could serve a revoked recipient a beat
   * after `revokedAt` is set (#534 AC4).
   */
  async resolveByToken(token: string) {
    const row = await this.db.query.portalRecipients.findFirst({
      where: and(eq(portalRecipients.token, token), isNull(portalRecipients.revokedAt)),
    });
    if (!row) throw new ForbiddenException('invalid or revoked recipient token');
    return row;
  }
}
