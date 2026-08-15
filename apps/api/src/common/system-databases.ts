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
 * The names below are ONLY for provisioning (what to call a database when
 * creating it) and for the migration's backfill. Never resolve an existing
 * database by them — that is the bug this module exists to have fixed.
 */
export const SYSTEM_DATABASE_NAMES = ['agents', 'runs', 'agent triggers', 'members'] as const;
