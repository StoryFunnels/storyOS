import { TOKEN_SCOPE_RANK, tokenScopeSchema } from '@storyos/schemas';
import type { TokenScope } from '@storyos/schemas';
import type { Role } from '../workspaces/workspace-access.guard';

/**
 * The agent's execution identity (#207, ADR-0010 §2).
 *
 * An agent never acts as itself: it acts as a *scoped principal derived from
 * its owner, intersected with the agent's declared scopes* — never broader than
 * either. The same guard stack that gates a PAT (MN-134) gates an agent run, so
 * an agent with `write` can never reach an `admin` route no matter what its
 * instructions say.
 */
export interface AgentPrincipal {
  /** The owner the run acts as — the run is attributed to them. */
  userId: string;
  /** Effective scope: min(owner scope, highest scope the agent declares). */
  scope: TokenScope;
}

/**
 * The owner's scope for a manual run, derived from their workspace membership
 * role. This is the *ceiling* — deriveAgentPrincipal can only lower it.
 *
 * admin → admin (schema + management), member → write (data work), guest → read.
 */
export const ROLE_SCOPE: Record<Role, TokenScope> = {
  admin: 'admin',
  member: 'write',
  guest: 'read',
};

/** The owner's scope ceiling for a manual run by this membership role. */
export function scopeForRole(role: Role): TokenScope {
  return ROLE_SCOPE[role];
}

/**
 * Derive the principal a run executes as.
 *
 * Effective scope = min(ownerScope, highest scope the agent declares).
 *  - An agent declaring more than its owner has is *capped*, never elevated.
 *  - An agent declaring nothing (or only junk) defaults to `read` — least
 *    privilege is the floor, not an error.
 *
 * Pure function on purpose: least privilege is the property most worth a
 * unit test, and this keeps it testable without a database.
 */
export function deriveAgentPrincipal(
  ownerUserId: string,
  ownerScope: TokenScope,
  agentScopes: string[],
): AgentPrincipal {
  // Unknown labels are ignored rather than trusted — a typo must not widen scope.
  const declared = agentScopes
    .map((s) => tokenScopeSchema.safeParse(s))
    .filter((r) => r.success)
    .map((r) => r.data);

  // Declaring nothing means read-only, never "whatever the owner has".
  const agentCeiling: TokenScope = declared.reduce<TokenScope>(
    (highest, s) => (TOKEN_SCOPE_RANK[s] > TOKEN_SCOPE_RANK[highest] ? s : highest),
    'read',
  );

  const scope =
    TOKEN_SCOPE_RANK[agentCeiling] < TOKEN_SCOPE_RANK[ownerScope] ? agentCeiling : ownerScope;
  return { userId: ownerUserId, scope };
}
