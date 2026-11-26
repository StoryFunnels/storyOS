/**
 * Which database a PR from a given repository links into (ticket #1368, absorbing #905). Pure: no DB, no I/O.
 *
 * Record numbers and identifier prefixes are per DATABASE, so "which database" is the whole question, and it must be answered per
 * REPOSITORY: with one workspace-wide value a `story-3` branch on one repo moves record 3 of the other repo's tickets.
 *
 * Two shapes of stored config, one rule each:
 *  - LEGACY (`link_databases` absent): the single `link_database_id` applies to every repo, exactly as before this ticket.
 *  - PER-REPO (`link_databases` present, even empty): ONLY a repo's own entry counts. A repo with no entry links nothing by number or
 *    identifier, never the legacy value and never another repo's: unconfigured means no match, not a guess (the #1219 rule).
 *
 * The first per-repo save migrates the legacy value into explicit entries (`withLinkDatabases`), so existing connections keep their
 * behaviour and the switch is made once, visibly, by an admin.
 */

export interface LinkConfig {
  link_database_id?: string;
  link_databases?: Record<string, string>;
  repos?: string[];
}

/** GitHub owner/name pairs are case-insensitive, so the map is keyed lower-case. */
export const repoKey = (repo: string) => repo.toLowerCase();

/** The link database for `repo`, or undefined when it has none (and so links nothing by number or identifier). */
export function linkDatabaseFor(config: LinkConfig, repo: string): string | undefined {
  if (config.link_databases === undefined) return config.link_database_id;
  return config.link_databases[repoKey(repo)];
}

/**
 * Apply a per-repo patch (`uuid` sets an entry, `null` removes it) and return the config fields that change. Migrates the legacy value
 * the first time: every watched repo that has no entry of its own inherits it explicitly, then the single field is dropped.
 */
export function withLinkDatabases(
  current: LinkConfig,
  patch: Record<string, string | null>,
): { link_databases: Record<string, string>; link_database_id: undefined } {
  const next: Record<string, string> = {};
  if (current.link_databases !== undefined) {
    for (const [k, v] of Object.entries(current.link_databases)) next[repoKey(k)] = v;
  } else if (current.link_database_id) {
    for (const repo of current.repos ?? []) next[repoKey(repo)] = current.link_database_id;
  }
  for (const [repo, database] of Object.entries(patch)) {
    if (database === null) delete next[repoKey(repo)];
    else next[repoKey(repo)] = database;
  }
  return { link_databases: next, link_database_id: undefined };
}
