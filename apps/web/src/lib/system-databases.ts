/**
 * #1058 — the Agentic OS system databases, as the sidebar and the database page name them.
 *
 * The STORED names are load-bearing (the API provisions and finds them by name, `agents.service.ts` and
 * `common/system-databases.ts`), so they are never renamed. The words a person sees come from this one map, keyed by the
 * stored name. A system database is one the API marked `is_system`: a person's own database called "Runs" is not one,
 * and is neither hidden nor relabelled.
 *
 * "Runs" alone is never shown: it collides with the "Automation runs" page, which is a different thing (rule runs).
 * Members is also `is_system` and is deliberately not here (ADR-0017): it keeps its place and its name.
 */
export type AgentSystemKey = 'agents' | 'runs' | 'agent triggers';

export const AGENT_SYSTEM_LABELS: Record<AgentSystemKey, string> = {
  agents: 'Agents',
  runs: 'Agent runs',
  'agent triggers': 'Triggers',
};

interface DatabaseLike {
  name: string;
  isSystem?: boolean;
}

/** Which Agentic OS system database this is, or null for anything else. Needs the `is_system` flag, never the name alone. */
export function agentSystemKey(db: DatabaseLike | null | undefined): AgentSystemKey | null {
  if (!db?.isSystem) return null;
  const key = db.name.trim().toLowerCase();
  return key in AGENT_SYSTEM_LABELS ? (key as AgentSystemKey) : null;
}

/** The name to show for a database: the label for an Agentic OS system database, its own name otherwise. */
export function databaseDisplayName(db: DatabaseLike | null | undefined): string {
  if (!db) return '';
  const key = agentSystemKey(db);
  return key ? AGENT_SYSTEM_LABELS[key] : db.name;
}

/** The three system databases among `dbs`, by key (absent when the workspace has not set agents up). */
export function agentSystemDatabases<T extends DatabaseLike>(dbs: readonly T[]): Partial<Record<AgentSystemKey, T>> {
  const out: Partial<Record<AgentSystemKey, T>> = {};
  for (const d of dbs) {
    const key = agentSystemKey(d);
    if (key && !out[key]) out[key] = d;
  }
  return out;
}

/**
 * Should this space be left out of the Spaces list? Only when it holds Agentic OS system databases and NOTHING else the
 * person could use: no database of their own, no document, folder or space view. A space someone put their own things in
 * stays, showing only those things. Nothing is deleted or moved either way.
 *
 * `extras` is undefined while the space's documents, folders and views are still loading. A candidate space stays hidden
 * until they say otherwise, so the common case (a system-only space) never flashes into the list and out again.
 */
export function isSystemOnlySpace(
  databases: readonly DatabaseLike[],
  extras: { documents: number; folders: number; views: number } | undefined,
): boolean {
  if (databases.length === 0) return false;
  if (!databases.every((d) => agentSystemKey(d) !== null)) return false;
  if (extras === undefined) return true;
  return extras.documents + extras.folders + extras.views === 0;
}
