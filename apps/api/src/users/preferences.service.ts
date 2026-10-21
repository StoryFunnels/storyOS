import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { userPreferences } from '../db/schema';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  type UserPreferences,
} from './preferences.constants';

/** The groups of the preferences blob a PATCH may write: the keys of `UserPreferences` (see `preferences.controller.ts`'s patch schema). */
const PATCHABLE = ['notifications', 'regional', 'myWork', 'github', 'activation', 'sidebar'] as const;

/** Read/write the per-user preferences blob (#30/#31). */
@Injectable()
export class PreferencesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(userId: string): Promise<UserPreferences> {
    const row = await this.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    });
    return mergePreferences(row?.preferences);
  }

  /**
   * Merge a partial patch into the stored preferences, ATOMICALLY (ticket #981).
   *
   * This used to read the whole blob, spread the patch over it and write ALL of it back, so two PATCHes for two different keys (a
   * notification toggle in one tab, a date format in another) raced: the later write put back the blob it had read before the other
   * landed and one vanished. It is now ONE statement — `INSERT .. ON CONFLICT DO UPDATE` whose new value is computed in SQL from the row
   * as it is at that moment: for each group the patch names, `stored.group || patch.group`. Postgres takes the row lock and re-reads the
   * latest committed version before evaluating that expression, so two writes to different groups — or to different keys of the same
   * group — can no longer lose each other. (A version check with retry would have worked too; it costs a loop and a failure mode, and this
   * needs neither.)
   *
   * The merge rule is the one the old code had: one level deep, per group (`{...stored.group, ...patch.group}`), so `myWork` replaces the
   * config of each database the patch names and keeps the rest. Only the groups the patch names are touched, and only the groups in
   * `PATCHABLE` are accepted. Defaults are applied on READ (`mergePreferences`), not baked into the stored blob.
   */
  async update(userId: string, patch: DeepPartial<UserPreferences>): Promise<UserPreferences> {
    const groups: Record<string, unknown> = {};
    for (const key of PATCHABLE) if (patch[key] !== undefined) groups[key] = patch[key];
    const patchJson = JSON.stringify(groups);
    const [row] = await this.db
      .insert(userPreferences)
      .values({ userId, preferences: groups, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          preferences: sql`${userPreferences.preferences} || COALESCE(
            (SELECT jsonb_object_agg(e.key, COALESCE(${userPreferences.preferences} -> e.key, '{}'::jsonb) || e.value)
               FROM jsonb_each(${patchJson}::jsonb) AS e),
            '{}'::jsonb)`,
          updatedAt: new Date(),
        },
      })
      .returning({ preferences: userPreferences.preferences });
    return mergePreferences(row?.preferences);
  }

  /** Notification toggles for many users at once, defaulted — used by NotificationsService. */
  async notificationPrefsFor(userIds: string[]): Promise<Map<string, UserPreferences['notifications']>> {
    const out = new Map<string, UserPreferences['notifications']>();
    if (userIds.length === 0) return out;
    const rows = await this.db.query.userPreferences.findMany({
      where: inArray(userPreferences.userId, userIds),
    });
    const stored = new Map(rows.map((r) => [r.userId, r.preferences]));
    for (const id of userIds) {
      out.set(id, stored.has(id) ? mergePreferences(stored.get(id)).notifications : DEFAULT_PREFERENCES.notifications);
    }
    return out;
  }
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };
