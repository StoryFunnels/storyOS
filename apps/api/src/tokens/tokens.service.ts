import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import type { ResourceScope, TokenScope } from '@storyos/schemas';
import { apiTokens, databases, memberships, spaces, type ChangeSource } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { AccessService } from '../access/access.service';
import { resolveAgentIdentity } from '../agents/agent-identity';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Personal access tokens (docs/architecture/auth.md): act as their creator. */
@Injectable()
export class TokensService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async create(
    userId: string,
    workspaceId: string,
    name: string,
    scope: TokenScope = 'admin',
    allowRunButton = true,
    /**
     * #357 — what kind of caller this token is for.
     *
     * Omitted for an ordinary personal access token, which reads as `mcp`
     * downstream. Tyron passes `agent` so its writes are distinguishable from
     * every other MCP client's, which #357 requires and #390 could not provide:
     * Tyron mints an ordinary PAT, so "authenticated by token" was as far as the
     * signal went.
     */
    origin?: ChangeSource,
    /**
     * #541 — mints this token FOR a specific Agent record, so its writes
     * resolve to "which agent" (auth.guard.ts), not just the 4-value
     * `origin` enum. Only meaningful alongside `origin: 'agent'`; the guard
     * re-verifies this id (and its owner) fresh on every request rather than
     * trusting it's still valid at use time — this column is only ever the
     * pointer minted here, never re-checked for existence at mint time
     * either, since that check belongs where it's actually load-bearing.
     */
    agentId?: string,
    /** #543 — bind the token to these spaces/databases. Omitted = unrestricted, as before. */
    resourceScope?: ResourceScope,
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

    // #541 — minting a token FOR an agent is itself a privileged act: only
    // that agent's own owner, or a workspace admin, may do it. Otherwise any
    // member could mint a credential that acts with another agent's (and
    // hence potentially another PERSON's) authority.
    if (agentId) {
      const identity = await resolveAgentIdentity(this.db, workspaceId, agentId);
      if (!identity) throw new NotFoundException('Agent not found');
      if (identity.ownerId !== userId && membership.role !== 'admin') {
        throw new ForbiddenException('Only this agent\'s owner or a workspace admin may mint a token for it');
      }
    }

    // #543 — never wider than the minter's own access, and the same 404 whether the id does
    // not exist or merely is not theirs: a mint request must not work as an existence probe.
    let boundTo: { space_ids: string[]; database_ids: string[] } | null = null;
    if (resourceScope) {
      const spaceIds = [...new Set(resourceScope.space_ids)];
      const databaseIds = [...new Set(resourceScope.database_ids)];
      for (const id of spaceIds) {
        const space = await this.db.query.spaces.findFirst({
          where: and(eq(spaces.id, id), eq(spaces.workspaceId, workspaceId), notDeleted(spaces.deletedAt)),
        });
        if (!space || !(await this.access.effectiveForSpace(membership, id))) {
          throw new NotFoundException('Space not found');
        }
      }
      for (const id of databaseIds) {
        const database = await this.db.query.databases.findFirst({
          where: and(eq(databases.id, id), eq(databases.workspaceId, workspaceId), notDeleted(databases.deletedAt)),
        });
        if (!database || !(await this.access.effectiveForDatabase(membership, database))) {
          throw new NotFoundException('Database not found');
        }
      }
      boundTo = { space_ids: spaceIds, database_ids: databaseIds };
    }

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
        origin,
        agentId,
        resourceScope: boundTo,
      })
      .returning();
    // Plaintext returned exactly once (E1).
    return {
      id: row!.id,
      name: row!.name,
      token,
      token_prefix: row!.tokenPrefix,
      scope: row!.scope,
      resource_scope: row!.resourceScope,
    };
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
        resource_scope: t.resourceScope,
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

  /**
   * Throttler-side identity (MN-248): the stable per-token key to rate-limit a
   * caller by, or null if the token doesn't resolve to a live principal.
   *
   * Read-only on purpose — no last_used stamp. The throttler runs on every
   * request and must stay cheap and side-effect free, and returning null for an
   * unresolvable token is load-bearing: it tells the guard to bucket the request
   * by IP rather than let a bogus token mint a fresh bucket of its own. The key
   * is the sha256 the token is already indexed by, not a new secret.
   */
  async identify(token: string): Promise<string | null> {
    const hash = sha256(token);
    const row = await this.db.query.apiTokens.findFirst({
      columns: { id: true },
      where: and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)),
    });
    return row ? hash : null;
  }

  /** Guard-side resolution: hash lookup, live check, throttled last_used stamp. */
  async resolve(
    token: string,
  ): Promise<{
    userId: string;
    workspaceId: string;
    scope: TokenScope;
    allowRunButton: boolean;
    /** #357 — null for an ordinary PAT, which the guard reads as `mcp`. */
    origin: ChangeSource | null;
    /** #541 — the pointer only; the guard resolves and verifies the live owner. */
    agentId: string | null;
    /** #543 — null for an unrestricted token. Read from the row on EVERY request, never cached. */
    resourceScope: { space_ids: string[]; database_ids: string[] } | null;
  } | null> {
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
    return {
      userId: row.userId,
      workspaceId: row.workspaceId,
      scope: row.scope,
      allowRunButton: row.allowRunButton,
      origin: row.origin,
      agentId: row.agentId,
      resourceScope: row.resourceScope,
    };
  }
}
