import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { portalRecipients } from '../db/schema';
import type { CreatePortalRecipientInput } from '@storyos/schemas';
import { mintPortalRecipientToken, parsePortalRecipientToken, verifyPortalRecipientSignature } from './portal-recipient-token';

type PortalRecipientRow = typeof portalRecipients.$inferSelect;

/** Attaches the live, re-derived bearer credential — never stored (#602). */
function withToken<T extends PortalRecipientRow>(row: T): T & { token: string } {
  return { ...row, token: mintPortalRecipientToken(row.id, row.tokenVersion) };
}

/**
 * #534 — identity and lifecycle for a portal recipient. Deliberately does NOT
 * scope which rows a recipient can read (filed separately) — this is the
 * entity itself: create, list, count, revoke, rotate, and resolve-by-token.
 */
@Injectable()
export class PortalRecipientsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(workspaceId: string, input: CreatePortalRecipientInput) {
    const [row] = await this.db
      .insert(portalRecipients)
      .values({
        workspaceId,
        label: input.label,
        email: input.email ?? null,
        linkedRecordId: input.linked_record_id ?? null,
        expiresAt: input.expires_at ? new Date(input.expires_at) : null,
      })
      .returning();
    return withToken(row!);
  }

  async list(workspaceId: string) {
    const rows = await this.db.query.portalRecipients.findMany({
      where: eq(portalRecipients.workspaceId, workspaceId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    return rows.map(withToken);
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
    return withToken(updated!);
  }

  /**
   * #602 AC3 — one atomic UPDATE bumps the version a token must embed to
   * verify; the instant it commits, every previously-minted token's embedded
   * version stops matching (checked in resolveByToken), so there is no window
   * where both the old and new token are valid, and none where neither is.
   */
  async rotate(workspaceId: string, recipientId: string) {
    const row = await this.db.query.portalRecipients.findFirst({
      where: and(eq(portalRecipients.id, recipientId), eq(portalRecipients.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('recipient not found');
    const [updated] = await this.db
      .update(portalRecipients)
      .set({ tokenVersion: sql`${portalRecipients.tokenVersion} + 1` })
      .where(eq(portalRecipients.id, recipientId))
      .returning();
    return withToken(updated!);
  }

  /**
   * The only consumer-facing check this ticket ships: resolves a bearer token
   * to its live recipient row.
   *
   * #602 — the signature is verified against the CLAIMED version embedded in
   * the token, with no DB read (a malformed or forged token is rejected
   * before ever touching the database). Only a token that is well-formed AND
   * correctly signed reaches the database at all, where its embedded version
   * is checked against the row's CURRENT one (catches a rotated-away token —
   * see portal-recipient-token.ts's doc) alongside revocation/expiry — no
   * cache, no session, nothing that could serve a stale answer a beat after
   * any of those change (#534 AC4).
   */
  async resolveByToken(token: string) {
    const parsed = parsePortalRecipientToken(token);
    if (!parsed || !verifyPortalRecipientSignature(parsed.recipientId, parsed.tokenVersion, parsed.signature)) {
      throw new ForbiddenException('invalid, expired, or revoked recipient token');
    }
    const row = await this.db.query.portalRecipients.findFirst({
      where: and(
        eq(portalRecipients.id, parsed.recipientId),
        eq(portalRecipients.tokenVersion, parsed.tokenVersion),
        isNull(portalRecipients.revokedAt),
        or(isNull(portalRecipients.expiresAt), gt(portalRecipients.expiresAt, new Date())),
      ),
    });
    if (!row) throw new ForbiddenException('invalid, expired, or revoked recipient token');
    return row;
  }
}
