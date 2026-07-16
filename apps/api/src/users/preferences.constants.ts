/**
 * Shared user-preferences shape + defaults (#30/#31). Kept out of the service so
 * both the preferences API and NotificationsService (which gates delivery on the
 * notification toggles) agree on the defaults and merge rules.
 */
export type DateFormat = 'system' | 'MDY' | 'DMY' | 'YMD';
export type TimeFormat = 'system' | '12h' | '24h';
export type FirstDayOfWeek = 'system' | 'sunday' | 'monday' | 'saturday';

export interface UserPreferences {
  /** Which record events produce an inbox notification for me. */
  notifications: {
    assigned: boolean;
    mentioned: boolean;
    commented: boolean;
    /** A select field (status/priority/…) changed on a record I'm assigned to (MN-073). */
    state_changed: boolean;
  };
  /** How dates/times render across the app. 'system' = the browser locale (default,
   * so nothing changes until the user picks). */
  regional: {
    dateFormat: DateFormat;
    timeFormat: TimeFormat;
    firstDayOfWeek: FirstDayOfWeek;
  };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: { assigned: true, mentioned: true, commented: true, state_changed: true },
  regional: { dateFormat: 'system', timeFormat: 'system', firstDayOfWeek: 'system' },
};

/** Merge a stored (possibly partial / legacy) blob over the defaults, so missing
 * keys always resolve to a sensible default. */
export function mergePreferences(stored: unknown): UserPreferences {
  const s = (stored ?? {}) as {
    notifications?: Partial<UserPreferences['notifications']>;
    regional?: Partial<UserPreferences['regional']>;
  };
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(s.notifications ?? {}) },
    regional: { ...DEFAULT_PREFERENCES.regional, ...(s.regional ?? {}) },
  };
}
