import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '../config/env';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { workspaces } from '../db/schema';
import { isSealedSetting, sealSetting, SEALED_SETTING_FIELDS, SEALED_TOP_LEVEL_SETTINGS } from '../common/settings-secret';

/** Every `settings` path that holds a credential, as jsonb_set paths. */
const SECRET_PATHS: string[][] = [
  ...Object.entries(SEALED_SETTING_FIELDS).flatMap(([blob, fields]) => fields.map((f) => [blob, f])),
  ...SEALED_TOP_LEVEL_SETTINGS.map((k) => [k]),
];

function at(settings: unknown, path: string[]): unknown {
  return path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), settings);
}

/**
 * #1239 — seal the integration credentials written in plaintext before `settings-secret.ts` existed. Each value is swapped with a
 * single-path `jsonb_set` guarded on the old plaintext still being there, so a save racing the backfill (or a second API replica
 * running it at the same time) is never overwritten: whichever write lands second simply finds nothing to do. Idempotent.
 */
export async function backfillSealedSettings(db: Db): Promise<{ sealed: number }> {
  const rows = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(sql`${workspaces.settings} ?| array['slack','github','linear','webhook_signing_secret']`);
  let sealed = 0;
  for (const row of rows) {
    for (const path of SECRET_PATHS) {
      const plain = at(row.settings, path);
      if (typeof plain !== 'string' || plain.length === 0 || isSealedSetting(plain)) continue;
      const pgPath = `{${path.join(',')}}`;
      const res = await db.execute(sql`
        UPDATE workspaces SET settings = jsonb_set(settings, ${pgPath}::text[], to_jsonb(${sealSetting(plain)}::text), false)
        WHERE id = ${row.id} AND settings #>> ${pgPath}::text[] = ${plain}`);
      sealed += (res as unknown as { rowCount?: number }).rowCount ?? 0;
    }
  }
  return { sealed };
}

/** Fire-and-forget at boot, skipped under test — the same shape as the title_local backfill. */
@Injectable()
export class SettingsSecretsBackfillSubscriber implements OnModuleInit {
  private readonly logger = new Logger(SettingsSecretsBackfillSubscriber.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    if (env().NODE_ENV === 'test') return;
    void backfillSealedSettings(this.db)
      .then((r) => this.logger.log(`integration secrets backfill: sealed ${r.sealed} value(s)`))
      .catch((error) => this.logger.warn(`integration secrets backfill failed: ${String(error)}`));
  }
}
