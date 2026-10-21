import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { apiTokens, databases, invites, memberships, records, workspaces } from '../db/schema';
import { oauthAccessToken } from '../db/auth-schema';
import { liveAiTokenCondition, liveOauthTokenCondition } from './ai-connection-predicates';

export interface ActivationState {
  records_added: boolean;
  teammate_invited: boolean;
  /** An AI client is connected, by EITHER route: a live personal access token a person minted, or a live hosted-MCP OAuth connection (#967 / #817). */
  ai_connected: boolean;
  /** Just the OAuth route of `ai_connected` (hosted MCP: claude.ai, Claude Desktop, ChatGPT). Carried so the event can say which half held. */
  ai_oauth_connected: boolean;
  /** #13's definition: a real record AND (a teammate invited OR an AI client connected). */
  activated: boolean;
}

/**
 * The ONE definition of the three facts "activated" is built from.
 *
 * They used to live inline in OnboardingController, which derives the Getting
 * Started checklist live. #817's `workspace_activated` event needs the very same
 * facts; a second copy of "what counts as a real record" or "what counts as an
 * AI client" is how a checklist that says one thing and a funnel that says
 * another get built, and this codebase has paid for that shape repeatedly.
 * Both consumers now read here, and the facts are derived from real workspace
 * state on every call — never a stored flag that can drift (MN-213).
 */
@Injectable()
export class ActivationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async exists(query: Promise<Array<unknown>>): Promise<boolean> {
    return (await query).length > 0;
  }

  /** A real, user-made record: not in a system database, not sample data, not deleted. */
  async recordsAdded(workspaceId: string): Promise<boolean> {
    // Sample records (installed by a template) don't count as "added records".
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const sampleIds = ((ws?.settings ?? {}) as { sample_record_ids?: string[] }).sample_record_ids ?? [];
    // #128: system databases (Members, and the Agentic OS pack) are provisioned
    // FOR the user, not BY them. #317: by flag, not by name.
    return this.exists(
      this.db
        .select({ one: sql`1` })
        .from(records)
        .innerJoin(databases, eq(databases.id, records.databaseId))
        .where(
          and(
            eq(databases.workspaceId, workspaceId),
            eq(databases.isSystem, false),
            isNull(records.deletedAt),
            ...(sampleIds.length ? [notInArray(records.id, sampleIds)] : []),
          ),
        )
        .limit(1),
    );
  }

  /** Someone else is, or has been asked to be, in the workspace. */
  async teammateInvited(workspaceId: string): Promise<boolean> {
    const activeMembers = await this.db
      .select({ one: sql`1` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')))
      .limit(2);
    if (activeMembers.length > 1) return true;
    return this.exists(
      this.db
        .select({ one: sql`1` })
        .from(invites)
        .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt)))
        .limit(1),
    );
  }

  /**
   * An AI/MCP client is connected through a personal access token: a live (not revoked) token a PERSON minted.
   *
   * Tyron mints an ordinary token for every turn it takes (`origin: 'agent'`, no
   * `agent_id`) and revokes it when the turn ends. Counting those would mark a
   * workspace "AI connected" for merely chatting with the in-app assistant, which
   * is not an external client connecting — and would inflate the funnel's most
   * important stage. A token minted for a configured Agent (`agent_id` set) is a
   * real connected client and does count.
   */
  async aiTokenConnected(workspaceId: string): Promise<boolean> {
    return this.exists(
      this.db
        .select({ one: sql`1` })
        .from(apiTokens)
        .where(
          and(eq(apiTokens.workspaceId, workspaceId), liveAiTokenCondition()),
        )
        .limit(1),
    );
  }

  /**
   * #967 — an MCP client has connected through OAuth (claude.ai, Claude Desktop, ChatGPT), and the connection is still live.
   *
   * The OAuth path is invisible to `aiConnected` above: an OAuth token belongs to a USER and a client, not to a workspace
   * (`oauth_access_token` has no workspace column), so no `api_tokens` row is ever written for it. A person who connected
   * Claude that way has an AI connected and the checklist said they did not.
   *
   * A workspace has one when an ACTIVE member of it holds an unexpired token. There is no revoked flag: revoking deletes the
   * row (and so does erasure), and an expired token with an expired refresh token can no longer be used, so "a row that has
   * not expired" is exactly "not revoked and still usable". This is per USER across workspaces, because that is what an OAuth
   * grant is: someone who connected Claude can reach every workspace they belong to, so each of them reads as connected.
   *
   * It is also the OAuth half of `ai_connected` (which now counts either route, #817), kept as its own fact so the checklist can
   * show it and the activation event can say which half held.
   */
  async mcpOauthConnected(workspaceId: string): Promise<boolean> {
    const now = new Date();
    return this.exists(
      this.db
        .select({ one: sql`1` })
        .from(oauthAccessToken)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, oauthAccessToken.userId), eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')),
        )
        .where(liveOauthTokenCondition(now))
        .limit(1),
    );
  }

  /**
   * An AI client is connected, by either route. #817 originally counted only personal access tokens, which undercounts activation:
   * hosted OAuth is how most people connect an AI (ticket #967), and an OAuth connection writes no `api_tokens` row. Product-owner
   * ruling 2026-10-21: the funnel counts a hosted-MCP OAuth connection too, so this is `token OR oauth`. Tyron's own per-turn
   * tokens still do not count (see `aiTokenConnected`).
   */
  async aiConnected(workspaceId: string): Promise<boolean> {
    const [token, oauth] = await Promise.all([this.aiTokenConnected(workspaceId), this.mcpOauthConnected(workspaceId)]);
    return token || oauth;
  }

  async evaluate(workspaceId: string): Promise<ActivationState> {
    const [records_added, teammate_invited, ai_token_connected, ai_oauth_connected] = await Promise.all([
      this.recordsAdded(workspaceId),
      this.teammateInvited(workspaceId),
      this.aiTokenConnected(workspaceId),
      this.mcpOauthConnected(workspaceId),
    ]);
    const ai_connected = ai_token_connected || ai_oauth_connected;
    return { records_added, teammate_invited, ai_connected, ai_oauth_connected, activated: records_added && (teammate_invited || ai_connected) };
  }
}
