import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, getTableColumns } from 'drizzle-orm';
import { cursorTimestampSql, encodeKeysetCursor, keysetCondition } from '../activity/keyset-cursor';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, apiTokens } from '../db/schema';

/**
 * #882 — the READ side of credential provenance: what a credential could reach (including after revocation or erasure) and which
 * actions were its. Admin-only (the controller), read-only, and deliberately blind to the person:
 *
 *  - `user_id`, the token hash/prefix and `last_used_at` are never selected. After an erasure the row's name is already
 *    'Erased token' and its user_id `erased:<id>` (gdpr.service.ts); before one, the person is still not in this response, so
 *    the action → token link cannot be joined back to a human through this surface.
 *  - Actions carry the event type, the record id and the source, not the actor.
 */
@Injectable()
export class CredentialsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** A credential of THIS workspace, live or revoked. 404 for anything else, so a foreign or made-up id is indistinguishable. */
  async get(workspaceId: string, id: string) {
    const row = await this.row(workspaceId, id);
    return {
      id: row.id,
      name: row.name,
      scope: row.scope,
      origin: row.origin,
      agent_id: row.agentId,
      allow_run_button: row.allowRunButton,
      /** null = unrestricted (every space and database the owner could reach). */
      resource_scope: row.resourceScope,
      created_at: row.createdAt,
      revoked_at: row.revokedAt,
    };
  }

  async actions(workspaceId: string, id: string, cursor?: string) {
    await this.row(workspaceId, id);
    const PAGE = 50;
    const rows = await this.db
      .select({ ...getTableColumns(activityEvents), cursorTs: cursorTimestampSql(activityEvents.createdAt) })
      .from(activityEvents)
      .where(and(eq(activityEvents.workspaceId, workspaceId), eq(activityEvents.tokenId, id), keysetCondition(activityEvents.createdAt, activityEvents.id, cursor)))
      .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
      .limit(PAGE);
    return {
      data: rows.map((e) => ({ id: e.id, type: e.type, record_id: e.recordId, source: e.source, created_at: e.createdAt })),
      next_cursor: rows.length === PAGE ? encodeKeysetCursor({ t: rows[PAGE - 1]!.cursorTs, id: rows[PAGE - 1]!.id }) : null,
    };
  }

  /** One past action and the credential that performed it (null: a session, an OAuth grant, an automation, or before this was recorded). */
  async event(workspaceId: string, eventId: string) {
    const row = await this.db.query.activityEvents.findFirst({
      where: and(eq(activityEvents.id, eventId), eq(activityEvents.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('event not found');
    return { id: row.id, type: row.type, record_id: row.recordId, source: row.source, created_at: row.createdAt, credential_id: row.tokenId };
  }

  private async row(workspaceId: string, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException('credential not found');
    const row = await this.db.query.apiTokens.findFirst({ where: and(eq(apiTokens.id, id), eq(apiTokens.workspaceId, workspaceId)) });
    if (!row) throw new NotFoundException('credential not found');
    return row;
  }
}
