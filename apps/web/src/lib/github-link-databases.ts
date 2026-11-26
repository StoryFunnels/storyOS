/**
 * Ticket #1368 — the GitHub link database is a per-REPO setting. Pure view-model for the settings rows; no React, no fetching.
 *
 * The API reports `link_databases: null` while the old workspace-wide value is still in force (every repo uses `link_database_id`) and
 * an object once the connection links per repository (only a repo's own entry counts; a repo with none links nothing). The rows say
 * which of the two a repo is on, so an admin never has to guess where a `story-3` branch will land.
 */
export interface LinkConfig {
  repos: string[];
  link_database_id?: string | null;
  link_databases?: Record<string, string> | null;
}

export interface LinkDatabaseOption {
  id: string;
  name: string;
  identifierPrefix?: string | null;
}

export interface LinkRow {
  repo: string;
  /** The database this repo links into, or null when it links nothing. */
  databaseId: string | null;
  /** True while the value is the old workspace-wide one rather than the repo's own choice. */
  inherited: boolean;
}

export const NO_LINK_DATABASE = '';

/** One row per watched repository (case-insensitive against the stored lower-case keys). */
export function linkRows(config: LinkConfig): LinkRow[] {
  const perRepo = config.link_databases ?? null;
  return config.repos.map((repo) => {
    if (perRepo === null) return { repo, databaseId: config.link_database_id ?? null, inherited: config.link_database_id != null };
    return { repo, databaseId: perRepo[repo.toLowerCase()] ?? null, inherited: false };
  });
}

/** The body of the one save call: this repo's database, or null to take its entry away. */
export function linkSaveBody(repo: string, databaseId: string): { link_databases: Record<string, string | null> } {
  return { link_databases: { [repo]: databaseId === NO_LINK_DATABASE ? null : databaseId } };
}

/** "Issues (ISSUE-n)" when the database carries an identifier prefix, the bare name otherwise. */
export function linkOptionLabel(d: LinkDatabaseOption): string {
  return d.identifierPrefix ? `${d.name} (${d.identifierPrefix}-n)` : d.name;
}

/** What a row tells the admin about the repo's matching, in one line. */
export function linkRowHint(row: LinkRow, db: LinkDatabaseOption | undefined): string {
  if (!row.databaseId) return 'Links nothing by branch name or identifier. A link to a StoryOS record in the description still works.';
  const name = db ? db.name : 'a database that no longer exists';
  const via = db?.identifierPrefix ? ` Matches ${db.identifierPrefix}-n in the branch, title or description, and story-n or ticket #n.` :' Matches story-n and ticket #n.';
  return `${row.inherited ? 'Workspace-wide setting: ' : ''}Links into ${name}.${via}`;
}
