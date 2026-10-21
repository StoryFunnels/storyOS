'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DEFAULT_REGIONAL, formatDate, formatDateTime } from '@/lib/format';

/** Mirrors the API's UserPreferences shape (apps/api/src/users/preferences.constants.ts). */
export interface UserPreferences {
  notifications: {
    assigned: boolean;
    mentioned: boolean;
    commented: boolean;
    state_changed: boolean;
    /** #591 — any field changed on a record I WATCH (#236), distinct from
     *  state_changed (a select field on a record I'm ASSIGNED to). */
    record_changed: boolean;
  };
  regional: {
    dateFormat: 'system' | 'MDY' | 'DMY' | 'YMD';
    timeFormat: 'system' | '12h' | '24h';
    firstDayOfWeek: 'system' | 'sunday' | 'monday' | 'saturday';
  };
  /** #43: the reviewer's own GitHub login — there's no per-user GitHub OAuth
   *  identity, so this is how the Reviews sidebar tells "needs my review" apart
   *  from "authored by me". */
  github: {
    login: string | null;
  };
  /** #155: workspace ids this user has dismissed the first-run activation
   *  checklist for. Per-workspace-per-user + server-stored so a dismissal sticks
   *  across the user's devices, unlike the old localStorage flag. */
  activation: {
    dismissedWorkspaces: string[];
  };
  /** #775: workspace ids where this user has views-only mode on (per user per
   *  workspace, server-stored so it follows them across devices). */
  sidebar: {
    viewsOnlyWorkspaces: string[];
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** Read the current user's preferences (defaults applied server-side). */
export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/users/me/preferences');
      if (error) throw error;
      return data as unknown as UserPreferences;
    },
  });
}

/** Date/time formatters bound to the current user's regional preferences (#30).
 * Falls back to locale defaults until preferences load. */
export function useDateFormat() {
  const prefs = usePreferences();
  const regional = prefs.data?.regional ?? DEFAULT_REGIONAL;
  return useMemo(
    () => ({
      date: (value: unknown) => formatDate(value, regional),
      dateTime: (value: unknown) => formatDateTime(value, regional),
    }),
    [regional.dateFormat, regional.timeFormat, regional.firstDayOfWeek],
  );
}

/**
 * #1007 (finishes #987) — the list-valued preferences, edited by ITEM. A whole-list PATCH was read-modify-write: two tabs
 * adding different workspaces each sent "the list I last saw plus mine", and the later one erased the other's. The
 * server's `PATCH /users/me/preferences/lists` adds and removes items atomically in SQL, so nothing is lost; the web
 * names only the item it means to change.
 */
export type PreferenceListName = 'dismissed_workspaces' | 'views_only_workspaces';
export interface PreferenceListEdit {
  list: PreferenceListName;
  add?: string[];
  remove?: string[];
}

/**
 * The list after an edit, computed the way the server computes it (preferences.service.ts `editList`): the stored items
 * that are not being removed, in their order, then the added items not already there; an item in both `add` and `remove`
 * is removed. Used for the optimistic update only — the server's answer replaces it.
 */
export function listAfterEdit(list: string[] | undefined, edit: { add?: string[]; remove?: string[] }): string[] {
  const remove = new Set(edit.remove ?? []);
  const out: string[] = [];
  for (const item of [...(list ?? []), ...(edit.add ?? [])]) {
    if (!remove.has(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/** The preferences with one list edited, for the optimistic cache write. */
export function withListEdit(prefs: UserPreferences, edit: PreferenceListEdit): UserPreferences {
  if (edit.list === 'dismissed_workspaces') {
    return {
      ...prefs,
      activation: { ...prefs.activation, dismissedWorkspaces: listAfterEdit(prefs.activation?.dismissedWorkspaces, edit) },
    };
  }
  return {
    ...prefs,
    sidebar: { ...prefs.sidebar, viewsOnlyWorkspaces: listAfterEdit(prefs.sidebar?.viewsOnlyWorkspaces, edit) },
  };
}

/** Add and/or remove items of one list preference, atomically on the server; the cache takes the merged preferences it returns. */
export function useEditPreferenceList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (edit: PreferenceListEdit) => {
      const { data, error } = await api.PATCH('/api/v1/users/me/preferences/lists', { body: edit as never });
      if (error) throw error;
      return data as unknown as UserPreferences;
    },
    onSuccess: (data) => qc.setQueryData(['preferences'], data),
  });
}

/** Patch (deep-merged server-side) the current user's preferences. */
export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: DeepPartial<UserPreferences>) => {
      const { data, error } = await api.PATCH('/api/v1/users/me/preferences', {
        body: patch as never,
      });
      if (error) throw error;
      return data as unknown as UserPreferences;
    },
    onSuccess: (data) => qc.setQueryData(['preferences'], data),
  });
}
