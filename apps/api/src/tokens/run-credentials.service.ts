import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { TOKEN_SCOPE_RANK } from '@storyos/schemas';
import type { TokenScope } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { apiTokens, databases, fields, memberships, records, selectOptions } from '../db/schema';
import { deriveAgentPrincipal, scopeForRole } from '../agents/agent-principal';
import { resolveAgentIdentity } from '../agents/agent-identity';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** ADR-0021 §4 / open question 3: a Runner run credential never carries `admin`, whatever the owner is or the agent declares. */
export const RUN_CREDENTIAL_SCOPE_CAP: TokenScope = 'write';

export interface MintedRunCredential {
  id: string;
  /** The plaintext, returned exactly once (at claim). Only its hash is stored. */
  token: string;
  scope: TokenScope;
  expires_at: Date;
}

type Executor = Pick<Db, 'update'>;

/**
 * #1132 / ADR-0021 §4 — the per-run credential. It is NOT a new kind of credential: it is an ordinary agent token (`api_tokens`
 * with `origin = 'agent'` and `agent_id`, `mn_pat_…`, so the guard, the throttler and the MCP server already know it) with an
 * expiry and the run it belongs to. The SERVER mints it at claim; the Runner never chooses its scope and a person cannot mint one
 * (no route does: `POST /me/tokens` has no such parameter, and it is filtered out of every "my tokens" surface by `runner_id`).
 *
 * It lives beside TokensService rather than inside it so that the guard-side `resolve` (which must stay dependency-light) is not
 * the place that mints, and so the wake code (runners module) depends on one small, named seam.
 */
@Injectable()
export class RunCredentialsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The scope labels the agent declares, resolved from the multi_select option ids its record stores. */
  private async declaredScopes(workspaceId: string, agentId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ values: records.values, fieldId: fields.id })
      .from(records)
      .innerJoin(databases, and(eq(databases.id, records.databaseId), eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents')))
      .innerJoin(fields, and(eq(fields.databaseId, databases.id), eq(fields.apiName, 'scopes')))
      .where(eq(records.id, agentId))
      .limit(1);
    if (!row) return [];
    const ids = ((row.values as Record<string, unknown>)[row.fieldId] as string[] | undefined) ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const options = await this.db
      .select({ id: selectOptions.id, label: selectOptions.label })
      .from(selectOptions)
      .where(and(eq(selectOptions.fieldId, row.fieldId), inArray(selectOptions.id, ids)));
    return options.map((o) => o.label);
  }

  /**
   * Mints the credential for one claimed wake, or returns null when none may exist: the agent is gone, its owner is no longer an
   * active member, or its owner is a GUEST (a Runner credential is at least as powerful as a PAT, and guests cannot create a PAT,
   * #1091). Scope = min(the owner's role, what the agent declares, write): never admin, read if the agent declares nothing.
   * Any earlier live credential for the same wake (a re-claim after a lost lease) is revoked first, so one wake has one.
   */
  async mint(input: {
    workspaceId: string;
    agentId: string;
    wakeId: string;
    runId: string | null;
    runnerId: string;
    depth: number;
    expiresAt: Date;
  }): Promise<MintedRunCredential | null> {
    const identity = await resolveAgentIdentity(this.db, input.workspaceId, input.agentId);
    if (!identity) return null;
    const owner = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, identity.ownerId), eq(memberships.status, 'active')),
      columns: { role: true },
    });
    if (!owner || owner.role === 'guest') return null;

    const declared = await this.declaredScopes(input.workspaceId, input.agentId);
    let scope = deriveAgentPrincipal(identity.ownerId, scopeForRole(owner.role), declared).scope;
    if (TOKEN_SCOPE_RANK[scope] > TOKEN_SCOPE_RANK[RUN_CREDENTIAL_SCOPE_CAP]) scope = RUN_CREDENTIAL_SCOPE_CAP;

    await this.revokeForWake(input.wakeId);
    const secret = randomBytes(24).toString('base64url');
    const token = `mn_pat_${secret}`;
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        userId: identity.ownerId,
        workspaceId: input.workspaceId,
        name: `Run credential (${identity.agentName})`,
        tokenHash: sha256(token),
        tokenPrefix: `mn_pat_${secret.slice(0, 4)}…${secret.slice(-4)}`,
        scope,
        // #1135 — never: a button runs the admin-authored action list (send_email to a member, http_request, send_webhook,
        // send_slack_message, post_social) with no approval step for an agent, and a Runner agent takes no approval_policy staging path.
        allowRunButton: false,
        origin: 'agent',
        agentId: input.agentId,
        runId: input.runId,
        runnerId: input.runnerId,
        wakeId: input.wakeId,
        runDepth: input.depth,
        expiresAt: input.expiresAt,
      })
      .returning({ id: apiTokens.id });
    return { id: row!.id, token, scope, expires_at: input.expiresAt };
  }

  /** The lease moved: the credential follows it (ADR-0021 §4: the expiry slides with the lease). */
  async extendForWake(wakeId: string, expiresAt: Date): Promise<void> {
    await this.db.update(apiTokens).set({ expiresAt }).where(and(eq(apiTokens.wakeId, wakeId), isNull(apiTokens.revokedAt)));
  }

  /** Complete, lease loss, cancel: the credential for this wake is refused from the next request on. */
  async revokeForWake(wakeId: string, now = new Date()): Promise<number> {
    const rows = await this.db.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.wakeId, wakeId), isNull(apiTokens.revokedAt))).returning({ id: apiTokens.id });
    return rows.length;
  }

  /** Removing a Runner: every live credential minted for it, in the same transaction as the removal when one is given. */
  async revokeForRunner(runnerId: string, now = new Date(), executor: Executor = this.db): Promise<number> {
    const rows = await executor.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.runnerId, runnerId), isNull(apiTokens.revokedAt))).returning({ id: apiTokens.id });
    return rows.length;
  }

  /** Is this agent still enabled? A disabled agent's credential is refused on its next call (ADR-0021 §4). */
  async agentEnabled(workspaceId: string, agentId: string): Promise<boolean> {
    const res = (await this.db.execute(sql`
      SELECT 1 FROM records r
        JOIN databases d ON d.id = r.database_id AND d.workspace_id = ${workspaceId}::uuid AND d.is_system = true AND d.system_key = 'agents'
        JOIN fields f ON f.database_id = d.id AND f.api_name = 'enabled'
      WHERE r.id = ${agentId}::uuid AND r.deleted_at IS NULL AND (r.values ->> f.id::text) = 'true' LIMIT 1`)) as unknown as { rows?: unknown[] };
    return (res.rows?.length ?? 0) > 0;
  }
}
