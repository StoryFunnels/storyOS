'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Mirrors the API's UserPreferences shape (apps/api/src/users/preferences.constants.ts). */
export interface UserPreferences {
  notifications: {
    assigned: boolean;
    mentioned: boolean;
    commented: boolean;
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
