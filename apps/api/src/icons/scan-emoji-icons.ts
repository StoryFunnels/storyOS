import { isEmojiShaped } from '@storyos/schemas/icons';
import { databases, spaces } from '../db/schema';
import type { Db } from '../db/client';

export interface EmojiIconHit {
  table: 'databases' | 'spaces';
  id: string;
  workspaceId: string;
  name: string;
  icon: string;
}

/**
 * Scan databases + spaces for any `icon` value that still looks like emoji
 * (#251 AC: "a post-migration scan finds zero emoji-shaped icon values").
 * Written as a real, reusable check — the emoji-icon migration script calls
 * this after running to report what (if anything) is left, and a test calls
 * it directly to assert the post-migration state without re-deriving the
 * "is this emoji" predicate.
 */
export async function scanEmojiIcons(db: Db): Promise<EmojiIconHit[]> {
  const [dbRows, spaceRows] = await Promise.all([
    db
      .select({ id: databases.id, workspaceId: databases.workspaceId, name: databases.name, icon: databases.icon })
      .from(databases),
    db
      .select({ id: spaces.id, workspaceId: spaces.workspaceId, name: spaces.name, icon: spaces.icon })
      .from(spaces),
  ]);

  const hits: EmojiIconHit[] = [];
  for (const row of dbRows) {
    if (isEmojiShaped(row.icon)) hits.push({ table: 'databases', ...row, icon: row.icon! });
  }
  for (const row of spaceRows) {
    if (isEmojiShaped(row.icon)) hits.push({ table: 'spaces', ...row, icon: row.icon! });
  }
  return hits;
}
