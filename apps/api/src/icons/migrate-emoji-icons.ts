/**
 * #251 — data backfill: migrate legacy emoji `icon` values on databases and
 * spaces to the curated SVG icon set (`set:<name>`) + a background-colour
 * token (#133's storage convention). No schema change — icon/color columns
 * already exist.
 *
 * Known emoji resolve via EMOJI_ICON_MIGRATION (built from #133's seed
 * template packs + the picker's pre-#251 emoji vocabulary). Anything else
 * emoji-shaped falls back to #133's name-inferred default
 * (inferIconFromName) so a database like "Clients" still lands on a
 * sensible icon (handshake, people) even with an obscure/no-longer-relevant
 * emoji.
 *
 * Idempotent: a row is only touched when its current `icon` is emoji-shaped
 * (isEmojiShaped). Once migrated, the value is a `set:` ref, which is never
 * emoji-shaped, so a second run finds nothing left to do for that row —
 * proven in migrate-emoji-icons.test.ts by running it twice.
 *
 * A row's existing `color` is preserved if already set (a user may have
 * picked a background alongside an emoji); only a null color gets the
 * migration's default.
 *
 * Run:
 *
 *     pnpm --filter @storyos/api icons:migrate
 */
import { eq } from 'drizzle-orm';
import { isEmojiShaped, resolveMigratedIcon } from '@storyos/schemas/icons';
import { env } from '../config/env';
import { createDb } from '../db/client';
import { databases, spaces } from '../db/schema';
import type { Db } from '../db/client';
import { scanEmojiIcons } from './scan-emoji-icons';

export interface MigrateEmojiIconsResult {
  scanned: number;
  migrated: number;
}

async function migrateDatabases(db: Db): Promise<MigrateEmojiIconsResult> {
  const rows = await db
    .select({ id: databases.id, name: databases.name, icon: databases.icon, color: databases.color })
    .from(databases);
  let migrated = 0;
  for (const row of rows) {
    if (!isEmojiShaped(row.icon)) continue;
    const result = resolveMigratedIcon(row.icon, row.name);
    if (!result) continue; // isEmojiShaped guarantees this isn't null, but keep TS happy
    await db
      .update(databases)
      .set({ icon: result.icon, color: row.color ?? result.color })
      .where(eq(databases.id, row.id));
    migrated++;
  }
  return { scanned: rows.length, migrated };
}

async function migrateSpaces(db: Db): Promise<MigrateEmojiIconsResult> {
  const rows = await db
    .select({ id: spaces.id, name: spaces.name, icon: spaces.icon, color: spaces.color })
    .from(spaces);
  let migrated = 0;
  for (const row of rows) {
    if (!isEmojiShaped(row.icon)) continue;
    const result = resolveMigratedIcon(row.icon, row.name);
    if (!result) continue;
    await db
      .update(spaces)
      .set({ icon: result.icon, color: row.color ?? result.color })
      .where(eq(spaces.id, row.id));
    migrated++;
  }
  return { scanned: rows.length, migrated };
}

/** Runs the backfill against an already-connected `db`. Exported (rather than
 * folded into main()) so tests can run it against the test database and
 * assert idempotency by calling it twice. */
export async function migrateEmojiIcons(db: Db): Promise<{ databases: MigrateEmojiIconsResult; spaces: MigrateEmojiIconsResult }> {
  const [dbResult, spaceResult] = [await migrateDatabases(db), await migrateSpaces(db)];
  return { databases: dbResult, spaces: spaceResult };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(env().DATABASE_URL);
  try {
    const result = await migrateEmojiIcons(db);
    console.log(
      [
        '',
        'Emoji icon migration (#251) complete:',
        `  databases: migrated ${result.databases.migrated} of ${result.databases.scanned} scanned`,
        `  spaces:    migrated ${result.spaces.migrated} of ${result.spaces.scanned} scanned`,
        '',
      ].join('\n'),
    );
    const remaining = await scanEmojiIcons(db);
    if (remaining.length > 0) {
      console.warn(
        `WARNING: ${remaining.length} emoji-shaped icon(s) remain after migration (no rule matched — check the mapping table):`,
      );
      for (const hit of remaining) console.warn(`  [${hit.table}] ${hit.id} "${hit.name}": ${hit.icon}`);
    } else {
      console.log('Post-migration scan: 0 emoji-shaped icons remain.');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Emoji icon migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
