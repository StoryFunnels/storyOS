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
