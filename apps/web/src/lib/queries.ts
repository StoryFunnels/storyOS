'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Space {
  id: string;
  name: string;
  icon: string | null;
  position: number;
}
export interface DatabaseSummary {
  id: string;
  spaceId: string;
  name: string;
  icon: string | null;
  apiSlug: string;
  position: number;
}
export interface WorkspaceInfo {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
}

function unwrap<T>({ data, error }: { data?: unknown; error?: unknown }): T {
  if (error) throw error;
  return data as T;
}

export function useWorkspace(ws: string) {
  return useQuery({
    queryKey: ['workspace', ws],
    queryFn: async () =>
      unwrap<WorkspaceInfo>(await api.GET('/api/v1/workspaces/{ws}', { params: { path: { ws } } })),
  });
}

export function useSpaces(ws: string) {
  return useQuery({
    queryKey: ['spaces', ws],
    queryFn: async () =>
      unwrap<Space[]>(await api.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws } } })),
  });
}

export function useDatabases(ws: string) {
  return useQuery({
    queryKey: ['databases', ws],
    queryFn: async () =>
      unwrap<DatabaseSummary[]>(
        await api.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws } } }),
      ),
  });
}

export function useSidebarMutations(ws: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['spaces', ws] });
    void qc.invalidateQueries({ queryKey: ['databases', ws] });
  };

  return {
    createSpace: useMutation({
      mutationFn: async (body: { name: string }) =>
        unwrap<Space>(
          await api.POST('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws } }, body }),
        ),
      onSuccess: invalidate,
    }),
    updateSpace: useMutation({
      mutationFn: async ({ id, ...body }: { id: string; name?: string; position?: number }) =>
        unwrap<Space>(
          await api.PATCH('/api/v1/workspaces/{ws}/spaces/{space}', {
            params: { path: { ws, space: id } },
            body,
          }),
        ),
      onSuccess: invalidate,
    }),
    deleteSpace: useMutation({
      mutationFn: async (id: string) =>
        unwrap<unknown>(
          await api.DELETE('/api/v1/workspaces/{ws}/spaces/{space}', {
            params: { path: { ws, space: id } },
          }),
        ),
      onSuccess: invalidate,
    }),
    createDatabase: useMutation({
      mutationFn: async (body: { space_id: string; name: string }) =>
        unwrap<DatabaseSummary>(
          await api.POST('/api/v1/workspaces/{ws}/databases', { params: { path: { ws } }, body }),
        ),
      onSuccess: invalidate,
    }),
    updateDatabase: useMutation({
      mutationFn: async ({
        id,
        ...body
      }: {
        id: string;
        name?: string;
        space_id?: string;
        position?: number;
      }) =>
        unwrap<DatabaseSummary>(
          await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}', {
            params: { path: { ws, db: id } },
            body,
          }),
        ),
      onSuccess: invalidate,
    }),
    deleteDatabase: useMutation({
      mutationFn: async ({ id, confirm }: { id: string; confirm: string }) =>
        unwrap<unknown>(
          await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}', {
            params: { path: { ws, db: id } },
            body: { confirm },
          }),
        ),
      onSuccess: invalidate,
    }),
  };
}
