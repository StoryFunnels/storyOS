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

/**
 * The list-valued preferences that are edited by ADDING and REMOVING items (ticket #987), each at a fixed place in the blob. The client
 * used to send the whole next list, so two tabs each adding a different item raced and one vanished; these are edited atomically instead.
 */
export const PREFERENCE_LISTS = {
  dismissed_workspaces: { group: 'activation', key: 'dismissedWorkspaces' },
  views_only_workspaces: { group: 'sidebar', key: 'viewsOnlyWorkspaces' },
} as const;
export type PreferenceListName = keyof typeof PREFERENCE_LISTS;
/** Same bound the whole-list PATCH always had, so the blob stays small. */
const MAX_LIST_ITEMS = 1000;

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

  /**
   * Add and/or remove items of one list-valued preference, ATOMICALLY (ticket #987).
   *
   * One `INSERT .. ON CONFLICT DO UPDATE` whose new list is computed in SQL from the row as it is at that moment: the stored items that are
   * not being removed, in their order, then the added items that are not already there (so adding twice is a no-op), de-duplicated. Postgres
   * re-reads the latest committed row under its lock before evaluating that, so two tabs adding DIFFERENT items cannot lose each other,
   * which is exactly what replacing the whole list could not guarantee. An item in both `add` and `remove` is removed. If the result would
   * pass `MAX_LIST_ITEMS` the OLDEST items are dropped, never the ones just added.
   */
  async editList(userId: string, list: PreferenceListName, edit: { add?: string[]; remove?: string[] }): Promise<UserPreferences> {
    const { group, key } = PREFERENCE_LISTS[list];
    const add = JSON.stringify([...new Set(edit.add ?? [])]);
    const remove = JSON.stringify([...new Set(edit.remove ?? [])]);
    const path = `{${group},${key}}`;
    const current = sql`(CASE WHEN jsonb_typeof(${userPreferences.preferences} #> ${path}::text[]) = 'array' THEN ${userPreferences.preferences} #> ${path}::text[] ELSE '[]'::jsonb END)`;
    const next = sql`(
      SELECT COALESCE(jsonb_agg(d.v ORDER BY d.o), '[]'::jsonb) FROM (
        SELECT t.v, t.o FROM (
          SELECT u.v, min(u.o) AS o FROM (
            SELECT e.value AS v, e.ordinality AS o FROM jsonb_array_elements(${current}) WITH ORDINALITY AS e
            UNION ALL
            SELECT a.value AS v, 1000000 + a.ordinality AS o FROM jsonb_array_elements(${add}::jsonb) WITH ORDINALITY AS a
          ) u
          WHERE u.v NOT IN (SELECT r.value FROM jsonb_array_elements(${remove}::jsonb) AS r)
          GROUP BY u.v
        ) t
        ORDER BY t.o DESC LIMIT ${MAX_LIST_ITEMS}
      ) d)`;
    const seed = { [group]: { [key]: (edit.add ?? []).filter((x) => !(edit.remove ?? []).includes(x)).slice(0, MAX_LIST_ITEMS) } };
    const [row] = await this.db
      .insert(userPreferences)
      .values({ userId, preferences: seed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          preferences: sql`jsonb_set(
            ${userPreferences.preferences} || jsonb_build_object(${group}::text, COALESCE(${userPreferences.preferences} -> ${group}::text, '{}'::jsonb)),
            ${path}::text[], ${next}, true)`,
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
