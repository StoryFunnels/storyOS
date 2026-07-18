import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FilterNode } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, userPreferences, views } from '../db/schema';
import { assertFilterFieldsLive, cleanFilterNode } from '../views/views.service';
import { DEFAULT_PREFERENCES, mergePreferences, type UserPreferences } from './preferences.constants';

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

  /** Deep-merge a partial patch over the stored (or default) preferences and upsert. */
  async update(userId: string, patch: DeepPartial<UserPreferences>): Promise<UserPreferences> {
    const current = await this.get(userId);
    const next: UserPreferences = {
      notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
      regional: { ...current.regional, ...(patch.regional ?? {}) },
      // Merge per-database: a patch replaces the config for the databases it names.
      // (Controller-validated values are full configs, never undefined.)
      myWork: { ...current.myWork, ...(patch.myWork ?? {}) } as UserPreferences['myWork'],
      // viewFilters (#259) is never part of this generic patch — it's managed by
      // the dedicated personal-filter endpoint (views/:view/personal-filter) so it
      // gets the view/field existence checks that live there. Carry it through
      // unchanged so an unrelated patch (e.g. a notification toggle) can never
      // silently wipe a personal filter override.
      viewFilters: current.viewFilters,
    };
    await this.db
      .insert(userPreferences)
      .values({ userId, preferences: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { preferences: next, updatedAt: new Date() },
      });
    return next;
  }

  /** The view row scoped to its database — 404 if missing/mismatched, same guard
   * every other view-scoped endpoint uses (ViewsService). */
  private async liveView(databaseId: string, viewId: string) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId)),
    });
    if (!view) throw new NotFoundException('View not found');
    return view;
  }

  private async liveApiNames(databaseId: string): Promise<Set<string>> {
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      columns: { apiName: true },
    });
    return new Set(live.map((f) => f.apiName));
  }

  /**
   * Personal filter override for one view (#259): narrows the shared view's
   * results for THIS user only. Cleaned at read time exactly like
   * `cleanViewConfig` cleans a view's own filters — dead field refs (the field
   * was deleted since the override was set) are pruned rather than persisted
   * forever or allowed to crash the query. Nothing is written back here; the
   * stored blob still carries the stale reference until the user next edits
   * their override, same as a view's own filters never get proactively
   * rewritten on field deletion either — the shared config's existing cleanup
   * pattern (databases.service.ts's `get()`) is a defensive READ, not a write.
   */
  async getViewFilter(userId: string, databaseId: string, viewId: string): Promise<FilterNode | undefined> {
    await this.liveView(databaseId, viewId);
    const stored = (await this.get(userId)).viewFilters[viewId];
    if (!stored) return undefined;
    const liveNames = await this.liveApiNames(databaseId);
    return cleanFilterNode(stored, liveNames) as FilterNode | undefined;
  }

  /** Validates the view exists and every condition references a live field
   * (422 otherwise, mirroring ViewsService's own filter validation), then
   * upserts the override. */
  async setViewFilter(
    userId: string,
    databaseId: string,
    viewId: string,
    filter: FilterNode,
  ): Promise<FilterNode | undefined> {
    await this.liveView(databaseId, viewId);
    const liveNames = await this.liveApiNames(databaseId);
    assertFilterFieldsLive(filter, liveNames);

    const current = await this.get(userId);
    const next: UserPreferences = { ...current, viewFilters: { ...current.viewFilters, [viewId]: filter } };
    await this.db
      .insert(userPreferences)
      .values({ userId, preferences: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { preferences: next, updatedAt: new Date() },
      });
    return next.viewFilters[viewId];
  }

  /**
   * Clears this user's override for one view. Idempotent (a second clear, or
   * clearing an override that was never set, is a no-op — not a 404) since the
   * client's "remove my personal filter" action shouldn't care which state it
   * started from.
   */
  async clearViewFilter(userId: string, databaseId: string, viewId: string): Promise<void> {
    await this.liveView(databaseId, viewId);
    const current = await this.get(userId);
    if (!(viewId in current.viewFilters)) return;
    const rest = { ...current.viewFilters };
    delete rest[viewId];
    const next: UserPreferences = { ...current, viewFilters: rest };
    await this.db
      .insert(userPreferences)
      .values({ userId, preferences: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { preferences: next, updatedAt: new Date() },
      });
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
