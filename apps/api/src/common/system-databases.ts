/**
 * The system databases — provisioned by their owning service, not by users, and
 * so excluded from user-facing "your databases" progress and portability
 * surfaces (onboarding's `database_created`/`records_added`, workspace export,
 * pack export).
 *
 * Identified by the `databases.is_system` COLUMN (#317/#318/#319). It used to
 * be the display name, which made the name load-bearing and produced a genuinely
 * nasty class of bug: a user who created their own database called "Members"
 * collided with the membership projection — its schema was mutated, colleagues'
 * emails and avatars were written into user content, and member removals stopped
 * tombstoning (#318). The same matching quietly dropped any user database named
 * Agents/Runs/Members from workspace export (#317).
 *
 * - Agentic OS pack (`AgentsService.ensurePack`): Agents, Runs, Agent Triggers.
 * - Members (#128, `MembersDbService`): the membership projection.
 *
 * #1063 — identity is the pair `is_system` + a fixed `system_key` (`agents` | `agent_triggers` | `agent_runs` | `members`), never the
 * display name. The flag alone said "some system database"; the key says WHICH, so a system database can be renamed or relabelled
 * ("Agent runs", "Triggers") without breaking the agent runtime, and a person's own database called "Runs" can never be mistaken for
 * one. Like the flag, the key cannot be set over HTTP. A database has at most one key and a workspace at most one database per key
 * (partial unique index). Names are ONLY what a database is called when it is created; never resolve an existing one by them.
 */
export const SYSTEM_DATABASE_KEYS = ['agents', 'agent_triggers', 'agent_runs', 'members'] as const;
export type SystemDatabaseKey = (typeof SYSTEM_DATABASE_KEYS)[number];

/**
 * Ticket #1296 (Otto's ruling, least privilege) — what a WHOLE-SPACE grant to an agent covers: the space's USER databases, never a
 * system database. The Members projection lives in the workspace's first space beside ordinary databases and holds every colleague's
 * email (ADR-0017); the Agents / Runs / Agent Triggers pack is system too. A system database reaches an agent only when someone NAMES
 * it in the agent's "Target databases", never by the space around it.
 *
 * THE one predicate. The scope resolver (`resolveAgentScope`, behind the scope endpoint, the Runner claim, the MCP `get_agent_scope`
 * and the web agent page) and the access layer's bound-credential rule (`AccessService.closedResources`) both call it, so what the
 * agent is told it can reach and what it can actually reach cannot drift. Identity is the `is_system` FLAG, never the name: a person's
 * own database called "Members" is a user database and stays covered.
 */
export function coveredByWholeSpaceGrant(database: { isSystem: boolean | null }): boolean {
  return !database.isSystem;
}
