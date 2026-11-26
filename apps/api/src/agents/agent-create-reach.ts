import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { TOKEN_SCOPE_RANK, tokenScopeSchema } from '@storyos/schemas';
import type { TokenScope } from '@storyos/schemas';
import type { Db } from '../db/client';
import { coveredByWholeSpaceGrant } from '../common/system-databases';
import { databases, fields, records, selectOptions } from '../db/schema';
import { parseTargetList, resolveAgentScope, toResourceScope } from './agent-scope';

/**
 * Ticket #1338 (sibling of #1336) — an AGENT that creates an agent record may not mint one whose reach is wider than its own.
 *
 * #1336 refuses an agent rewriting the scope fields of an agent record that exists. A create was left open because a pack install and an
 * architect build create agents with `source: 'agent'` for provenance; those run as the signed-in MEMBER, with no agent credential at the
 * door, and they stay untouched. What this decides is the other caller: a credential that IS an agent (a run credential, an agent-bound
 * token, an agent-origin token, or a run executor acting as an agent) writing a new agent record.
 *
 * The rule, in terms of what the new agent's own credential could reach:
 *  - Databases: the new agent's "Target databases" must be a SUBSET of the creator's scope, each named by ID. A NAME is refused: it binds
 *    when the new agent runs, and a database created tomorrow under that name could be one the creator cannot reach.
 *  - A new agent that names no database at all is UNBOUND, which means it reaches everything its owner can. That is wider than a bound
 *    creator, so a bound creator may not mint it. An unbound creator may: its own reach is the owner's, and so is the new agent's (the
 *    owner of a record is who created it, `resolveAgentIdentity`), and the live binding applies the owner's access on every request.
 *  - Scopes: the highest scope the new agent declares may not exceed the creator's own ceiling (its credential's scope).
 *  - Target spaces: already refused for every agent-source write (`assertAgentSettingsWritable`).
 * A write a person APPROVED (the approvals executor's marker) is not checked: a person saw it and said yes.
 */

export interface AgentCreator {
  agentId: string | null;
  /** The credential's own ceiling, when the request carried one. Null = look it up from the agent's record. */
  ceiling: TokenScope | null;
  /** The credential's #543 binding. `undefined` = not known from the request: resolve it live from the agent record. */
  resourceScope: { space_ids: string[]; database_ids: string[] } | null | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: the reason a new agent is wider than its creator, or null when it is not. */
export function agentCreateProblem(input: {
  /** Ids the creator reaches, or null when the creator is unbound. */
  creatorReach: ReadonlySet<string> | null;
  creatorCeiling: TokenScope;
  /** The new agent's "Target databases" entries. */
  entries: string[];
  /** The highest scope the new agent declares, null when it declares none. */
  newCeiling: TokenScope | null;
}): string | null {
  if (input.newCeiling && TOKEN_SCOPE_RANK[input.newCeiling] > TOKEN_SCOPE_RANK[input.creatorCeiling]) {
    return `An agent cannot create an agent with higher Scopes than its own (${input.creatorCeiling}).`;
  }
  if (input.creatorReach === null) return null;
  if (input.entries.length === 0) {
    return 'An agent can only create an agent that names the databases it works in, and only ones this agent can itself reach: an agent that names none reaches everything its manager can.';
  }
  for (const entry of input.entries) {
    if (!UUID_RE.test(entry)) {
      return 'An agent that creates an agent must name each target database by id: a name is resolved later and could mean a database this agent cannot reach.';
    }
    if (!input.creatorReach.has(entry.toLowerCase())) {
      return 'An agent cannot create an agent that reaches a database it cannot reach itself: a person sets that.';
    }
  }
  return null;
}

/** The highest rank among the labels, ignoring anything that is not a scope (a typo never widens). */
function ceilingOf(labels: string[]): TokenScope | null {
  let best: TokenScope | null = null;
  for (const l of labels) {
    const parsed = tokenScopeSchema.safeParse(l);
    if (parsed.success && (best === null || TOKEN_SCOPE_RANK[parsed.data] > TOKEN_SCOPE_RANK[best])) best = parsed.data;
  }
  return best;
}

async function scopeOptions(db: Db, agentsDatabaseId: string): Promise<{ fieldId: string; byId: Map<string, string> } | null> {
  const [field] = await db.select({ id: fields.id }).from(fields).where(and(eq(fields.databaseId, agentsDatabaseId), eq(fields.apiName, 'scopes'))).limit(1);
  if (!field) return null;
  const rows = await db.select({ id: selectOptions.id, label: selectOptions.label }).from(selectOptions).where(eq(selectOptions.fieldId, field.id));
  return { fieldId: field.id, byId: new Map(rows.map((r) => [r.id, r.label])) };
}

/** The ceiling an agent RECORD declares (its stored "Scopes"), `read` when it declares nothing. */
async function declaredCeiling(db: Db, agentsDatabaseId: string, agentId: string): Promise<TokenScope> {
  const options = await scopeOptions(db, agentsDatabaseId);
  if (!options) return 'read';
  const row = await db.query.records.findFirst({ where: and(eq(records.id, agentId), eq(records.databaseId, agentsDatabaseId), isNull(records.deletedAt)), columns: { values: true } });
  const ids = ((row?.values ?? {}) as Record<string, unknown>)[options.fieldId];
  const labels = Array.isArray(ids) ? ids.map((id) => options.byId.get(String(id))).filter((l): l is string => Boolean(l)) : [];
  return ceilingOf(labels) ?? 'read';
}

/**
 * Throws (a 403 from the caller) when `input`, a new agent record, is wider than `creator`. `input` is the write as the caller sent it.
 * The Agents database id is passed in: the caller already established the target IS the Agents database (the is_system flag + system key).
 */
export async function assertAgentCreateWithinReach(
  db: Db,
  args: { workspaceId: string; agentsDatabaseId: string; input: Record<string, unknown>; creator: AgentCreator },
  refuse: (message: string) => Error,
): Promise<void> {
  const { workspaceId, agentsDatabaseId, input, creator } = args;

  let resourceScope = creator.resourceScope;
  if (resourceScope === undefined) {
    const live = creator.agentId ? await resolveAgentScope(db, workspaceId, creator.agentId) : null;
    resourceScope = live?.enforced ? toResourceScope(live) : null;
  }

  let reach: Set<string> | null = null;
  if (resourceScope) {
    const rows = await db
      .select({ id: databases.id, isSystem: databases.isSystem, spaceId: databases.spaceId })
      .from(databases)
      .where(
        and(
          eq(databases.workspaceId, workspaceId),
          isNull(databases.deletedAt),
          or(
            resourceScope.database_ids.length ? inArray(databases.id, resourceScope.database_ids) : undefined,
            resourceScope.space_ids.length ? inArray(databases.spaceId, resourceScope.space_ids) : undefined,
          ),
        ),
      );
    // Same predicate the access layer applies to the credential: a whole-space binding covers USER databases only; a system one is reached
    // only when it is named by id.
    reach = new Set(rows.filter((r) => resourceScope!.database_ids.includes(r.id) || (resourceScope!.space_ids.includes(r.spaceId) && coveredByWholeSpaceGrant(r))).map((r) => r.id.toLowerCase()));
  }

  const creatorCeiling = creator.ceiling ?? (creator.agentId ? await declaredCeiling(db, agentsDatabaseId, creator.agentId) : 'read');

  let newCeiling: TokenScope | null = null;
  const declared = input['scopes'];
  if (Array.isArray(declared) && declared.length > 0) {
    const options = await scopeOptions(db, agentsDatabaseId);
    const labels = declared.map((v) => options?.byId.get(String(v)) ?? String(v));
    newCeiling = ceilingOf(labels);
  }

  const problem = agentCreateProblem({ creatorReach: reach, creatorCeiling, entries: parseTargetList(input['target_databases']), newCeiling });
  if (problem) throw refuse(problem);
}
