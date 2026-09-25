/**
 * #764 (Phase 3, step 1) — rewrite every stored view config's reference to the
 * deprecated `number` api_name / `__sys_number` id (#743) to `id` / `__sys_id`.
 * Both spellings resolve identically today (SYSTEM_FIELDS keeps `number`
 * `deprecated: true` for exactly this reason), so this is a rename with no
 * value change — never delete-then-recreate, per #743's own "deprecate-then-
 * migrate, never rename-in-place" rule this ticket exists to finish.
 *
 * Idempotent: a view is only written when scanConfigForNumberRefs finds a hit
 * (proven by running it twice in migrate-number-field-refs.test.ts). Removing
 * `number` from SYSTEM_FIELDS (#764 AC3) is a SEPARATE, later step — it does
 * not happen here, and must not happen until this migration has actually run
 * against every real environment and scanNumberFieldRefs confirms zero
 * remaining hits there (a query, not a belief, per #743's own standard this
 * ticket restates).
 *
 * Run:
 *
 *     pnpm --filter @storyos/api views:migrate-number-refs
 */
// #658: MUST be the first import — see main.ts's own comment. Without this,
// apps/api/.env is never read and DATABASE_URL silently falls back to the
// shared founder dev database — dangerous here specifically, since this
// script MUTATES existing rows rather than only creating new ones.
import '../config/load-env';
import { eq, isNull } from 'drizzle-orm';
import { env } from '../config/env';
import { createDb } from '../db/client';
import { views } from '../db/schema';
import type { Db } from '../db/client';
import { rewriteConfigNumberRefs } from './number-field-ref-rewrite';
import { scanNumberFieldRefs } from './scan-number-field-refs';

export interface MigrateNumberFieldRefsResult {
  scanned: number;
  migrated: number;
}

/** Runs the rewrite against an already-connected `db`. Exported (rather than
 * folded into main()) so tests can run it against the test database and
 * assert idempotency by calling it twice — same shape as
 * migrateEmojiIcons/#251. */
export async function migrateNumberFieldRefs(db: Db): Promise<MigrateNumberFieldRefsResult> {
  const rows = await db.query.views.findMany({
    columns: { id: true, config: true },
    where: isNull(views.deletedAt),
  });
  let migrated = 0;
  for (const row of rows) {
    const rewritten = rewriteConfigNumberRefs(row.config);
    if (rewritten === row.config) continue; // no hit found — nothing to write
    await db.update(views).set({ config: rewritten }).where(eq(views.id, row.id));
    migrated++;
  }
  return { scanned: rows.length, migrated };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(env().DATABASE_URL);
  try {
    const result = await migrateNumberFieldRefs(db);
    console.log(
      [
        '',
        'Number field-ref migration (#764) complete:',
        `  views: migrated ${result.migrated} of ${result.scanned} scanned`,
        '',
      ].join('\n'),
    );
    const remaining = await scanNumberFieldRefs(db);
    if (remaining.length > 0) {
      console.warn(
        `WARNING: ${remaining.length} view(s) still reference the deprecated 'number' field after migration:`,
      );
      for (const hit of remaining) console.warn(`  [${hit.viewId}] "${hit.name}": ${hit.locations.join(', ')}`);
      console.warn('Do NOT remove `number` from SYSTEM_FIELDS (#764 AC3) until this is zero.');
    } else {
      console.log("Post-migration scan: 0 views reference 'number'. Safe to proceed with #764 AC3 once every environment confirms this.");
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Number field-ref migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
