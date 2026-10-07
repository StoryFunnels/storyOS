import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { apiTokens, databases, invites, memberships, records, workspaces } from '../db/schema';

export interface ActivationState {
  records_added: boolean;
  teammate_invited: boolean;
  ai_connected: boolean;
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
   * An AI/MCP client is connected: a live (not revoked) token a PERSON minted.
   *
   * Tyron mints an ordinary token for every turn it takes (`origin: 'agent'`, no
   * `agent_id`) and revokes it when the turn ends. Counting those would mark a
   * workspace "AI connected" for merely chatting with the in-app assistant, which
   * is not an external client connecting — and would inflate the funnel's most
   * important stage. A token minted for a configured Agent (`agent_id` set) is a
   * real connected client and does count.
   */
  async aiConnected(workspaceId: string): Promise<boolean> {
    return this.exists(
      this.db
        .select({ one: sql`1` })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.workspaceId, workspaceId),
            isNull(apiTokens.revokedAt),
            // NULL-safe on purpose: an ordinary personal access token has origin NULL, and
            // `NOT (NULL = 'agent' AND ...)` is NULL, which would silently EXCLUDE every
            // normal token. IS DISTINCT FROM treats NULL as "not agent", which is the point.
            sql`(${apiTokens.origin} IS DISTINCT FROM 'agent' OR ${apiTokens.agentId} IS NOT NULL)`,
          ),
        )
        .limit(1),
    );
  }

  async evaluate(workspaceId: string): Promise<ActivationState> {
    const [records_added, teammate_invited, ai_connected] = await Promise.all([
      this.recordsAdded(workspaceId),
      this.teammateInvited(workspaceId),
      this.aiConnected(workspaceId),
    ]);
    return { records_added, teammate_invited, ai_connected, activated: records_added && (teammate_invited || ai_connected) };
  }
}
