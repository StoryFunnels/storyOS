import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { apiTokens, memberships } from '../db/schema';
import { oauthAccessToken, oauthApplication, oauthConsent } from '../db/auth-schema';
import { liveAiTokenCondition, liveOauthTokenCondition } from './ai-connection-predicates';

export interface AiConnection {
  /** `oauth:<client id>` or `token:<token id>`: what DELETE takes. */
  id: string;
  kind: 'oauth' | 'token';
  /** OAuth: the name the client registered itself with (Claude, ChatGPT, ...). Token: the name the person gave it. */
  client_name: string;
  connected_at: string | null;
  /** Tokens record it; OAuth does not (null, not "never"). */
  last_used_at: string | null;
  /** An OAuth connection belongs to the PERSON and reaches every workspace they are in; a token belongs to one workspace. */
  reaches: 'all_your_workspaces' | 'this_workspace';
}

const OAUTH = 'oauth:';
const TOKEN = 'token:';

/**
 * Ticket #1008 — the AI clients the CALLER has connected (name, how, since when), and the way to disconnect one. It is the per-person
 * half of the fact `ActivationService.aiConnected` answers per workspace, and both read the same row conditions
 * (`ai-connection-predicates.ts`), so the list cannot say "nothing" while the checklist says "connected" for the same person.
 */
@Injectable()
export class AiConnectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The caller's connections visible from `workspaceId`: their live OAuth connections (all workspaces) and their live tokens for THIS workspace. */
  async list(userId: string, workspaceId: string): Promise<{ data: AiConnection[] }> {
    const member = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')),
    });
    // The same answer as a workspace that does not exist: nothing here confirms it.
    if (!member) throw new NotFoundException('Workspace not found');

    const oauthRows = await this.db
      .select({
        clientId: oauthAccessToken.clientId,
        clientName: oauthApplication.name,
        createdAt: oauthAccessToken.createdAt,
      })
      .from(oauthAccessToken)
      .leftJoin(oauthApplication, eq(oauthApplication.clientId, oauthAccessToken.clientId))
      .where(and(eq(oauthAccessToken.userId, userId), liveOauthTokenCondition()))
      .orderBy(asc(oauthAccessToken.createdAt));
    const consents = await this.db
      .select({ clientId: oauthConsent.clientId, createdAt: oauthConsent.createdAt })
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, userId));

    // One connection per CLIENT, however many access/refresh tokens it has cycled through. It started at the earliest token or consent.
    const byClient = new Map<string, { name: string; since: Date | null }>();
    for (const row of oauthRows) {
      if (!row.clientId) continue;
      const known = byClient.get(row.clientId);
      const at = row.createdAt ?? null;
      if (!known) byClient.set(row.clientId, { name: row.clientName?.trim() || 'Unnamed client', since: at });
      else if (at && (!known.since || at < known.since)) known.since = at;
    }
    for (const consent of consents) {
      const known = consent.clientId ? byClient.get(consent.clientId) : undefined;
      if (known && consent.createdAt && (!known.since || consent.createdAt < known.since)) known.since = consent.createdAt;
    }
    const oauth: AiConnection[] = [...byClient].map(([clientId, c]) => ({
      id: `${OAUTH}${clientId}`,
      kind: 'oauth',
      client_name: c.name,
      connected_at: c.since?.toISOString() ?? null,
      last_used_at: null,
      reaches: 'all_your_workspaces',
    }));

    const tokenRows = await this.db.query.apiTokens.findMany({
      where: and(eq(apiTokens.userId, userId), eq(apiTokens.workspaceId, workspaceId), liveAiTokenCondition()),
      orderBy: [asc(apiTokens.createdAt)],
    });
    const tokens: AiConnection[] = tokenRows.map((t) => ({
      id: `${TOKEN}${t.id}`,
      kind: 'token',
      client_name: t.name,
      connected_at: t.createdAt.toISOString(),
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      reaches: 'this_workspace',
    }));

    return { data: [...oauth, ...tokens].sort((a, b) => (a.connected_at ?? '').localeCompare(b.connected_at ?? '')) };
  }

  /**
   * Disconnect one of the CALLER'S connections. A token is revoked; an OAuth connection loses every access and refresh token and its
   * consent for that client, so neither can be used again (the guard validates an OAuth bearer by looking the row up on every request).
   * Someone else's connection answers "not found", the same as one that never existed.
   */
  async disconnect(userId: string, id: string): Promise<{ disconnected: true }> {
    if (id.startsWith(TOKEN)) {
      const tokenId = id.slice(TOKEN.length);
      if (!/^[0-9a-f-]{36}$/i.test(tokenId)) throw new NotFoundException('Connection not found');
      const revoked = await this.db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      if (revoked.length === 0) throw new NotFoundException('Connection not found');
      return { disconnected: true };
    }
    if (id.startsWith(OAUTH)) {
      const clientId = id.slice(OAUTH.length);
      const removed = await this.db.transaction(async (tx) => {
        const tokens = await tx
          .delete(oauthAccessToken)
          .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)))
          .returning({ id: oauthAccessToken.id });
        const consents = await tx
          .delete(oauthConsent)
          .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
          .returning({ id: oauthConsent.id });
        return tokens.length + consents.length;
      });
      if (removed === 0) throw new NotFoundException('Connection not found');
      return { disconnected: true };
    }
    throw new NotFoundException('Connection not found');
  }

  /** Only a person at a keyboard may disconnect a client: an API token or an OAuth client cannot cut off the person's other clients. */
  assertSession(via: string | undefined): void {
    if (via !== 'session') throw new ForbiddenException('Sign in to disconnect an AI client: an API token cannot do this');
  }
}
