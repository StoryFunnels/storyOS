import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AccessService } from '../access/access.service';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { databases, fields, memberships, records, spaces } from '../db/schema';
import { resolveAgentIdentity } from './agent-identity';

/**
 * Ticket #1195 — an agent's scope is its databases PLUS its spaces, and a space resolves to its databases AT CALL TIME.
 *
 * THE one resolver. The request guard (auth.guard.ts), the agent API (agents.controller.ts) and the Runner claim
 * (agent-wakes.service.ts) all call `resolveAgentScope`; none of them re-implements "what is in a space". Nothing here is
 * expanded at hire: the stored value is the manager's own text ("Works in"), and a database created in a targeted space tomorrow
 * is in scope on the very next call, because the space is read again on every call.
 *
 * Dependency-free (raw schema queries) for the same reason `resolveAgentIdentity` is: the auth guard cannot inject the services.
 *
 * What this does NOT decide: whether the agent's MANAGER (its owner) may open a database. That is the access layer's job and it
 * runs live on every request, through the #543 binding (`boundTokenGrants`: a bound token is never wider than its owner, and
 * never reaches another member's personal space). The list returned here is the candidate set; `AgentsService.describeScope`
 * narrows it with the manager's real access before showing it to a person.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One entry of a "Works in" list: a name or an id, comma or newline separated, blanks ignored, duplicates dropped. */
export function parseTargetList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const v = part.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export interface ScopeDatabase {
  id: string;
  name: string;
  space_id: string;
  /** Why it is in scope: named directly, or through a targeted space. A database that is both reads as `database`. */
  via: 'database' | 'space';
}

export interface ScopeSpace {
  id: string;
  name: string;
}

export interface ResolvedAgentScope {
  /**
   * True when the agent targets at least one SPACE. Only then is the scope enforced on its credential: a database-only agent keeps
   * exactly the behaviour it had before this ticket (its "Target databases" text is the agent's brief, not a boundary).
   */
  enforced: boolean;
  spaces: ScopeSpace[];
  databases: ScopeDatabase[];
  /** Entries that matched nothing, or matched a personal space: listed so the manager can see why, never silently dropped. */
  unresolved: string[];
}

interface AgentTargets {
  databases: string[];
  spaces: string[];
}

/** The agent's two "Works in" lists, read off its record by field api_name. Null when the agent does not exist. */
export async function readAgentTargets(db: Db, workspaceId: string, agentId: string): Promise<AgentTargets | null> {
  const agentsDb = await db.query.databases.findFirst({
    where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents'), isNull(databases.deletedAt)),
    columns: { id: true },
  });
  if (!agentsDb) return null;
  const rec = await db.query.records.findFirst({
    where: and(eq(records.id, agentId), eq(records.databaseId, agentsDb.id), isNull(records.deletedAt)),
    columns: { values: true },
  });
  if (!rec) return null;
  const fieldRows = await db.query.fields.findMany({
    where: and(eq(fields.databaseId, agentsDb.id), inArray(fields.apiName, ['target_databases', 'target_spaces'])),
    columns: { id: true, apiName: true },
  });
  const values = (rec.values ?? {}) as Record<string, unknown>;
  const read = (apiName: string) => {
    const f = fieldRows.find((r) => r.apiName === apiName);
    return f ? parseTargetList(values[f.id]) : [];
  };
  return { databases: read('target_databases'), spaces: read('target_spaces') };
}

/** Resolve names/ids against live rows. Pure, so the matching rule is testable and identical on every surface. */
export function matchEntries<T extends { id: string; name: string }>(entries: string[], rows: T[]): { hits: T[]; missed: string[] } {
  const hits: T[] = [];
  const missed: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const found = rows.filter((r) => (UUID_RE.test(entry) ? r.id === entry.toLowerCase() : r.name.toLowerCase() === lower));
    if (found.length === 0) missed.push(entry);
    for (const f of found) if (!hits.some((h) => h.id === f.id)) hits.push(f);
  }
  return { hits, missed };
}

export async function resolveAgentScope(db: Db, workspaceId: string, agentId: string): Promise<ResolvedAgentScope | null> {
  const targets = await readAgentTargets(db, workspaceId, agentId);
  if (!targets) return null;

  // Spaces: live rows, never a personal space (personal-space.md: private from everyone, so never an agent's reach).
  const spaceRows = targets.spaces.length
    ? await db.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.personal, false), isNull(spaces.deletedAt)))
    : [];
  const spaceMatch = matchEntries(targets.spaces, spaceRows);

  // Databases: every live database in a targeted space (read NOW, which is what makes the space target live), plus the ones named.
  const inSpaces = spaceMatch.hits.length
    ? await db
        .select({ id: databases.id, name: databases.name, spaceId: databases.spaceId })
        .from(databases)
        .where(and(eq(databases.workspaceId, workspaceId), inArray(databases.spaceId, spaceMatch.hits.map((s) => s.id)), isNull(databases.deletedAt)))
    : [];
  const out = new Map<string, ScopeDatabase>();
  for (const d of inSpaces) out.set(d.id, { id: d.id, name: d.name, space_id: d.spaceId, via: 'space' });

  let missedDbs: string[] = [];
  if (targets.databases.length) {
    const named = await db
      .select({ id: databases.id, name: databases.name, spaceId: databases.spaceId, personal: spaces.personal })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(and(eq(databases.workspaceId, workspaceId), isNull(databases.deletedAt)));
    const m = matchEntries(targets.databases, named.filter((d) => !d.personal));
    missedDbs = m.missed;
    for (const d of m.hits) out.set(d.id, { id: d.id, name: d.name, space_id: d.spaceId, via: 'database' });
  }

  return {
    enforced: targets.spaces.length > 0,
    spaces: spaceMatch.hits,
    databases: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unresolved: [...spaceMatch.missed, ...missedDbs],
  };
}

/** The #543 binding a live scope turns into: the same shape `api_tokens.resource_scope` carries, but never stored. */
export function toResourceScope(scope: ResolvedAgentScope): { space_ids: string[]; database_ids: string[] } {
  // Space ids bind the whole space LIVE (boundTokenGrants reads the space's databases per request); named databases that sit
  // outside every targeted space are bound one by one. A named database inside a targeted space is already covered.
  const spaceIds = scope.spaces.map((s) => s.id);
  const covered = new Set(spaceIds);
  return {
    space_ids: spaceIds,
    database_ids: scope.databases.filter((d) => d.via === 'database' && !covered.has(d.space_id)).map((d) => d.id),
  };
}

export interface DescribedAgentScope extends ResolvedAgentScope {
  /** How many candidates the manager's access removed, so "why is my database missing" has an answer. */
  withheld_count: number;
}

/**
 * The agent's scope as a person sees it (agent API, Runner claim): the one resolver, with `databases` narrowed to what the agent's
 * MANAGER can open right now. A database the manager cannot open is not listed (listing it would tell the manager it exists) and is
 * not reachable by the agent either: the live binding applies the same rule on every request. Stateless; AccessService is global.
 */
@Injectable()
export class AgentScopeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async describe(workspaceId: string, agentId: string): Promise<DescribedAgentScope | null> {
    const scope = await resolveAgentScope(this.db, workspaceId, agentId);
    if (!scope) return null;
    const identity = await resolveAgentIdentity(this.db, workspaceId, agentId);
    const owner = identity
      ? await this.db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, identity.ownerId), eq(memberships.status, 'active')) })
      : null;
    // No active manager: nothing is reachable (the guard refuses such an agent outright), so nothing is listed.
    if (!owner) return { ...scope, databases: [], withheld_count: scope.databases.length };
    const roles = await this.access.effectiveForDatabases(owner, scope.databases.map((d) => ({ id: d.id, spaceId: d.space_id })));
    const visible = scope.databases.filter((d) => roles.get(d.id) != null);
    return { ...scope, databases: visible, withheld_count: scope.databases.length - visible.length };
  }
}
