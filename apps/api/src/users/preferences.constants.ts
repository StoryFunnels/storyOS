import type { FilterNode } from '@storyos/schemas';

/**
 * Shared user-preferences shape + defaults (#30/#31). Kept out of the service so
 * both the preferences API and NotificationsService (which gates delivery on the
 * notification toggles) agree on the defaults and merge rules.
 */
export type DateFormat = 'system' | 'MDY' | 'DMY' | 'YMD';
export type TimeFormat = 'system' | '12h' | '24h';
export type FirstDayOfWeek = 'system' | 'sunday' | 'monday' | 'saturday';

/** A My Work filter clause — mirrors packages/schemas' FilterCondition (MN-253 UI):
 * the non-destructive disabled/pinned/label/icon fields ride along the same way a
 * saved view's filters do, since My Work uses the same builder + config shape. */
export interface MyWorkFilterCondition {
  field: string;
  op: string;
  value?: unknown;
  disabled?: boolean;
  pinned?: boolean;
  label?: string;
  icon?: string;
}

/** A My Work sort key — mirrors packages/schemas' sortSchema (MN-252). */
export interface MyWorkSortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

/** Per-database My Work view config (MN-072 part 2), a ViewConfig subset. */
export interface MyWorkDbConfig {
  group_by_field_id?: string;
  color_by_field_id?: string;
  /** Dense fields hidden from the row (by field id). */
  hidden_field_ids?: string[];
  /** Flat filter (and/or, MN-253 UI), applied to the returned records client-side. */
  filters?: { and: MyWorkFilterCondition[] } | { or: MyWorkFilterCondition[] };
  /** Sort precedence (MN-252), applied client-side to the already-fetched records —
   * same builder + spec as saved views, reusing the same "and/or is flat" pattern. */
  sorts?: MyWorkSortSpec[];
  /** Whole-sort empty-values placement (MN-252); undefined = trailing. */
  sorts_nulls?: 'first' | 'last';
}

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
  /** My Work per-database config, keyed by database id (MN-072 part 2). */
  myWork: Record<string, MyWorkDbConfig>;
  /**
   * Personal filter overrides (#259), keyed by view id. Narrows a shared view's
   * results for THIS user only — layered on top of the view's own filters at
   * query time (`{and:[shared, personal]}`, mirroring #258/calendar-view.tsx's
   * date-window AND-wrap), never written back to the view's own ViewConfig.
   * Reuses the SAME FilterNode AST a view's `filters` uses (packages/schemas'
   * query.ts) rather than a forked shape — unlike `myWork.filters` above, which
   * predates this and forked its own condition type.
   */
  viewFilters: Record<string, FilterNode>;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: { assigned: true, mentioned: true, commented: true, state_changed: true },
  regional: { dateFormat: 'system', timeFormat: 'system', firstDayOfWeek: 'system' },
  myWork: {},
  viewFilters: {},
};

/** Merge a stored (possibly partial / legacy) blob over the defaults, so missing
 * keys always resolve to a sensible default. */
export function mergePreferences(stored: unknown): UserPreferences {
  const s = (stored ?? {}) as {
    notifications?: Partial<UserPreferences['notifications']>;
    regional?: Partial<UserPreferences['regional']>;
    myWork?: UserPreferences['myWork'];
    viewFilters?: UserPreferences['viewFilters'];
  };
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(s.notifications ?? {}) },
    regional: { ...DEFAULT_PREFERENCES.regional, ...(s.regional ?? {}) },
    myWork: { ...(s.myWork ?? {}) },
    viewFilters: { ...(s.viewFilters ?? {}) },
  };
}
