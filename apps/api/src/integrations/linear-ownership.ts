/**
 * Ticket #1370 — who owns a Linear team's records: Linear (the mirror, today's behaviour) or StoryOS (the switch has been thrown).
 *
 * ONE state per team, kept in the Linear settings JSON (`settings.linear.team_ownership`), so there is one switch for everything that
 * reads it: the Linear sync (`linear.service.ts`), GitHub PR linking (`github-webhook.service.ts`) and, when it lands, Slack. Anything
 * that moves or writes a mirrored record asks `teamOwnership` / `ownerOfDatabase` first; nothing else gets its own flag, because two
 * flags to keep in step is how one PR ends up setting the same status from two directions (ticket #905's rule).
 *
 *   linear   — Linear owns every field it maps. Each sync rewrites them. The default, and what a team with no entry is.
 *   storyos  — cut over. Linear is read-only history: no inbound sync writes this team's records, ever. Reversible by an admin only.
 *
 * Pure parts only here, plus one read helper; the flip itself (the final sync, the counter, the audit event) is `LinearService`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases, fields, workspaces } from '../db/schema';

export type TeamOwner = 'linear' | 'storyos';

export interface TeamOwnershipEntry {
  owner: TeamOwner;
  /** When the state last changed, and which member changed it (the actor, never an agent identity). */
  changed_at: string;
  changed_by: string;
  /** Set when the team was handed to StoryOS: the moment, and what the final full read of the team found. */
  cut_over_at?: string;
  final_sync?: { mode: 'full' | 'incremental'; issues: number; linear_issue_total: number | null };
  /** The Issues database counter, moved ahead by the headroom at cutover so a straggler created in Linear shows as a gap. */
  counter?: { database_id: string; before: number; after: number; headroom: number };
}

/** The slice of the Linear settings this module reads. Not sealed: no secret lives in it, so it can be read without the key. */
export interface OwnershipSettings {
  team_ownership?: Record<string, TeamOwnershipEntry>;
  team_spaces?: Record<string, { space_id?: string; space_name?: string }>;
}

export const DEFAULT_COUNTER_HEADROOM = 50;
export const MAX_COUNTER_HEADROOM = 10_000;

/**
 * The state of one team. A team with no entry is owned by Linear. An entry whose owner is not exactly `linear` reads as `storyos`:
 * state that cannot be read as written must protect what people have edited in StoryOS, never expose it to an overwrite.
 */
export function teamOwnership(settings: OwnershipSettings | null | undefined, teamKey: string): { owner: TeamOwner } & Partial<TeamOwnershipEntry> {
  const all = settings?.team_ownership;
  if (!all) return { owner: 'linear' };
  const wanted = teamKey.toLowerCase();
  const found = Object.entries(all).find(([key]) => key.toLowerCase() === wanted);
  if (!found) return { owner: 'linear' };
  const entry = found[1];
  if (!entry || typeof entry !== 'object') return { owner: 'storyos' };
  return entry.owner === 'linear' ? { ...entry, owner: 'linear' } : { ...entry, owner: 'storyos' };
}

/** The team keys StoryOS owns, among the ones given. */
export function storyosOwnedKeys(settings: OwnershipSettings | null | undefined, teamKeys: string[]): string[] {
  return teamKeys.filter((key) => teamOwnership(settings, key).owner === 'storyos');
}

/** The Linear team whose mirror lives in this space (by the id the sync stored, never by the space's name), or null. */
export function teamKeyOfSpace(settings: OwnershipSettings | null | undefined, spaceId: string): string | null {
  for (const [key, target] of Object.entries(settings?.team_spaces ?? {})) if (target?.space_id === spaceId) return key;
  return null;
}

/**
 * Who owns a mirrored database: the team key and owner when the database is one of a Linear team's mirrored databases (it lives in a
 * team's space AND carries the importer's `linear_id` field), or null when it is not a mirror at all, so a caller that only cares
 * about mirrors can leave every other database exactly as it was.
 */
export async function ownerOfDatabase(db: Db, workspaceId: string, databaseId: string): Promise<{ team_key: string; owner: TeamOwner } | null> {
  const database = await db.query.databases.findFirst({ where: and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId)), columns: { spaceId: true } });
  if (!database) return null;
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { settings: true } });
  const linear = ((ws?.settings ?? {}) as { linear?: OwnershipSettings }).linear;
  const teamKey = teamKeyOfSpace(linear, database.spaceId);
  if (!teamKey) return null;
  const mirrored = await db.query.fields.findFirst({ where: and(eq(fields.databaseId, databaseId), eq(fields.apiName, 'linear_id'), isNull(fields.deletedAt)), columns: { id: true } });
  return mirrored ? { team_key: teamKey, owner: teamOwnership(linear, teamKey).owner } : null;
}
