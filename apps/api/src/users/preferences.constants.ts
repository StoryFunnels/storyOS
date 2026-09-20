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

/** A collection-view filter clause — mirrors `MyWorkFilterCondition`'s flat
 * field/op/value shape (#736): the embedded-collection builder is the same
 * component/condition type as My Work's, not the recursive view FilterNode. */
export interface CollectionViewFilterCondition {
  field: string;
  op: string;
  value?: unknown;
}

/** A collection-view sort key — mirrors `MyWorkSortSpec`. */
export interface CollectionViewSortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Personal override for one embedded relation collection (#736) — mirrors
 * apps/web's `CollectionView` (entity-field-utils.ts). Kept as its own type
 * here rather than imported: apps/api has no dependency on apps/web, and this
 * codebase's own precedent for a preferences sub-shape that mirrors a web-only
 * type (see `MyWorkFilterCondition` above) is to duplicate the shape with a
 * comment, not to invent a shared package for a UI-state type nothing else needs.
 */
export interface CollectionViewConfig {
  filters?: { and: CollectionViewFilterCondition[] } | { or: CollectionViewFilterCondition[] };
  sorts?: CollectionViewSortSpec[];
  sorts_nulls?: 'first' | 'last';
  color_by?: string;
  fields?: string[];
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
    /** Any field changed on a record I WATCH (#236). Distinct from state_changed:
     * fires for a watcher on any change, not just an assignee on a select change. */
    record_changed: boolean;
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
  /**
   * Personal embedded-collection view overrides (#736), keyed by the RELATION
   * FIELD's id. An embedded collection (apps/web's collection-section.tsx)
   * used to write its filter/sort/color-by/inline-columns straight onto the
   * field's own shared `config.collection_view` — one viewer's filter became
   * everyone's, permanently. This is the per-user layer instead, read in
   * PREFERENCE to the field's own config (which stays as the shared DEFAULT
   * everyone without a personal override still sees, so existing configs keep
   * working unmigrated — #736 AC3). Managed by its own dedicated endpoint
   * (fields/:field/personal-collection-view), same reason viewFilters is.
   */
  collectionFilters: Record<string, CollectionViewConfig>;
  /**
   * GitHub identity for the Reviews sidebar (#43). There is no per-user GitHub
   * OAuth identity in this app (the App connect (#247) is workspace-level,
   * installation-based, with no user-context token) — the reviewer's own
   * `login` is how "needs my review" / "authored by me" / "participating" are
   * told apart when querying GitHub's search API (which needs an explicit
   * `review-requested:<login>`, not `@me`, from an installation token).
   */
  github: {
    login: string | null;
  };
  /**
   * First-run activation checklist (#155). The Getting-Started checklist on the
   * workspace home is dismissible; `dismissedWorkspaces` holds the workspace ids
   * this user has dismissed it for. Per-workspace-per-user so dismissing on one
   * workspace never hides it on another, and server-stored (not localStorage) so
   * the dismissal survives across the user's devices/browsers. Completion itself
   * is NOT stored here — it's derived live from real state (onboarding.controller
   * .ts, MN-213); this flag only records the manual "hide it" choice.
   */
  activation: {
    dismissedWorkspaces: string[];
  };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: { assigned: true, mentioned: true, commented: true, state_changed: true, record_changed: true },
  regional: { dateFormat: 'system', timeFormat: 'system', firstDayOfWeek: 'system' },
  myWork: {},
  viewFilters: {},
  collectionFilters: {},
  github: { login: null },
  activation: { dismissedWorkspaces: [] },
};

/** Merge a stored (possibly partial / legacy) blob over the defaults, so missing
 * keys always resolve to a sensible default. */
export function mergePreferences(stored: unknown): UserPreferences {
  const s = (stored ?? {}) as {
    notifications?: Partial<UserPreferences['notifications']>;
    regional?: Partial<UserPreferences['regional']>;
    myWork?: UserPreferences['myWork'];
    viewFilters?: UserPreferences['viewFilters'];
    collectionFilters?: UserPreferences['collectionFilters'];
    github?: Partial<UserPreferences['github']>;
    activation?: Partial<UserPreferences['activation']>;
  };
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(s.notifications ?? {}) },
    regional: { ...DEFAULT_PREFERENCES.regional, ...(s.regional ?? {}) },
    myWork: { ...(s.myWork ?? {}) },
    viewFilters: { ...(s.viewFilters ?? {}) },
    collectionFilters: { ...(s.collectionFilters ?? {}) },
    github: { ...DEFAULT_PREFERENCES.github, ...(s.github ?? {}) },
    activation: {
      dismissedWorkspaces: [...(s.activation?.dismissedWorkspaces ?? [])],
    },
  };
}
