/**
 * Shared user-preferences shape + defaults (#30/#31). Kept out of the service so
 * both the preferences API and NotificationsService (which gates delivery on the
 * notification toggles) agree on the defaults and merge rules.
 */
export interface UserPreferences {
  /** Which record events produce an inbox notification for me. */
  notifications: {
    assigned: boolean;
    mentioned: boolean;
    commented: boolean;
  };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: { assigned: true, mentioned: true, commented: true },
};

/** Merge a stored (possibly partial / legacy) blob over the defaults, so missing
 * keys always resolve to a sensible on-by-default value. */
export function mergePreferences(stored: unknown): UserPreferences {
  const s = (stored ?? {}) as { notifications?: Partial<UserPreferences['notifications']> };
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(s.notifications ?? {}) },
  };
}
