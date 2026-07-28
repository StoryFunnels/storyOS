/**
 * The system databases — provisioned by their owning service, not by users, and
 * so excluded from user-facing "your databases" progress and portability
 * surfaces (onboarding's `database_created`/`records_added`, workspace export,
 * pack export). Identified by name, because there is no per-database
 * `is_system` column (adding one is a migration; system DBs deliberately reuse
 * the ordinary databases/records/fields tables).
 *
 * - Agentic OS pack (`AgentsService.ensurePack`): Agents, Runs, Agent Triggers.
 * - Members (#128, `MembersDbService`): the membership projection.
 */
export const SYSTEM_DATABASE_NAMES = ['agents', 'runs', 'agent triggers', 'members'] as const;

const SYSTEM_DATABASE_NAME_SET = new Set<string>(SYSTEM_DATABASE_NAMES);

/** True if `name` is one of the system databases, case-insensitively. */
export function isSystemDatabaseName(name: string): boolean {
  return SYSTEM_DATABASE_NAME_SET.has(name.trim().toLowerCase());
}
