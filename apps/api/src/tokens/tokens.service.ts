import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import type { TokenScope } from '@storyos/schemas';
import { apiTokens, memberships } from '../db/schema';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Personal access tokens (docs/architecture/auth.md): act as their creator. */
@Injectable()
export class TokensService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(
    userId: string,
    workspaceId: string,
    name: string,
    scope: TokenScope = 'admin',
    allowRunButton = true,
  ) {
    // MN-122: a token is only meaningful for a workspace you're actually in.
    // Without this you could mint one for any uuid — it would grant nothing
    // (membership is still checked per request), but it's junk state and it
    // muddies what a token means. 404 keeps the no-leak convention.
    const membership = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    });
    if (!membership) throw new NotFoundException('Workspace not found');

    const secret = randomBytes(24).toString('base64url');
    const token = `mn_pat_${secret}`;
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        userId,
        workspaceId,
        name,
        tokenHash: sha256(token),
        tokenPrefix: `mn_pat_${secret.slice(0, 4)}…${secret.slice(-4)}`,
        scope,
        // run_button lives in write scope but can be withheld even there (MN-134).
        allowRunButton: scope === 'read' ? false : allowRunButton,
      })
      .returning();
    // Plaintext returned exactly once (E1).
    return { id: row!.id, name: row!.name, token, token_prefix: row!.tokenPrefix, scope: row!.scope };
  }

  async list(userId: string) {
    const rows = await this.db.query.apiTokens.findMany({
      where: and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)),
      orderBy: [desc(apiTokens.createdAt)],
    });
    return {
      data: rows.map((t) => ({
        id: t.id,
        name: t.name,
        token_prefix: t.tokenPrefix,
        workspace_id: t.workspaceId,
        scope: t.scope,
        allow_run_button: t.allowRunButton,
        last_used_at: t.lastUsedAt,
        created_at: t.createdAt,
      })),
    };
  }

  async revoke(userId: string, tokenId: string) {
    const [revoked] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning();
    if (!revoked) throw new NotFoundException('Token not found');
    return { revoked: true };
  }

  /** Guard-side resolution: hash lookup, live check, throttled last_used stamp. */
  async resolve(
    token: string,
  ): Promise<{ userId: string; workspaceId: string; scope: TokenScope; allowRunButton: boolean } | null> {
    const row = await this.db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)),
    });
    if (!row) return null;
    const now = Date.now();
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000) {
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, row.id));
    }
    return { userId: row.userId, workspaceId: row.workspaceId, scope: row.scope, allowRunButton: row.allowRunButton };
  }
}
