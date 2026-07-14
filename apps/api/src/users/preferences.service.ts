import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { userPreferences } from '../db/schema';
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
