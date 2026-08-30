'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Space {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  /** #400's purpose line. Absent from this type until #457 — which is part of why
   *  nothing in the app ever offered to write one. */
  description?: string | null;
}
export interface DatabaseSummary {
  id: string;
  spaceId: string;
  folderId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  apiSlug: string;
  position: number;
  spaceSlug?: string | null;
  qualifiedSlug?: string;
  /** #400 — the one-line purpose. Null/absent is the normal state. */
  description?: string | null;
}
export interface WorkspaceInfo {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
  /** #400's purpose line, writable from the app since #457. */
  description?: string | null;
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

export function useSpaces(ws: string, enabled = true) {
  return useQuery({
    queryKey: ['spaces', ws],
    queryFn: async () =>
      unwrap<Space[]>(await api.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws } } })),
    enabled: enabled && Boolean(ws),
  });
}

export function useDatabases(ws: string, enabled = true) {
  return useQuery({
    queryKey: ['databases', ws],
    queryFn: async () =>
      unwrap<DatabaseSummary[]>(
        await api.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws } } }),
      ),
    enabled: enabled && Boolean(ws),
  });
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  name: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

/** MN-263: the http_request action's connection picker needs just the 'http'-
 * provider subset — shared here (rather than duplicating settings/connections'
 * local hook) so both call sites invalidate the same react-query cache key. */
export function useHttpConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws],
    queryFn: async () =>
      unwrap<{ data: ConnectionSummary[] }>(
        await api.GET('/api/v1/workspaces/{ws}/connections', { params: { path: { ws } } }),
      ).data,
    select: (rows: ConnectionSummary[]) => rows.filter((c) => c.provider === 'http'),
  });
}

export function useSidebarMutations(ws: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['spaces', ws] });
    void qc.invalidateQueries({ queryKey: ['databases', ws] });
    // #457 — the sidebar's LIST of databases (`['databases', ws]`) and the open
    // database's OWN record (`['database', ws, db]`, from `useDatabase`) are
    // separate queries reading the same row. Only the list was invalidated here,
    // so a rename or an icon change refreshed the sidebar while the database page
    // showing the same thing kept the old value until a reload. That was invisible
    // while everything these mutations changed was rendered only in the sidebar;
    // the description is the first field written from the sidebar and read on the
    // page, so it surfaced immediately (the line under the title stayed blank
    // until F5). Invalidating the singular key too keeps the two in step.
    void qc.invalidateQueries({ queryKey: ['database', ws] });
  };

  return {
    /**
     * #457 — the workspace's purpose line. The PATCH endpoint has existed since
     * #400; nothing in the web app ever called it, which is why a workspace could
     * be described by an agent but not by a person.
     */
    updateWorkspace: useMutation({
      mutationFn: async (body: { name?: string; description?: string | null }) =>
        unwrap<WorkspaceInfo>(
          await api.PATCH('/api/v1/workspaces/{ws}', { params: { path: { ws } }, body }),
        ),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['workspace', ws] });
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
      },
    }),
    createSpace: useMutation({
      mutationFn: async (body: { name: string }) =>
        unwrap<Space>(
          await api.POST('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws } }, body }),
        ),
      onSuccess: invalidate,
    }),
    updateSpace: useMutation({
      mutationFn: async ({ id, ...body }: { id: string; name?: string; icon?: string | null; color?: string | null; position?: number; description?: string | null }) =>
        unwrap<Space>(
          await api.PATCH('/api/v1/workspaces/{ws}/spaces/{space}', {
            params: { path: { ws, space: id } },
            body,
          }),
        ),
      onSuccess: invalidate,
    }),
    deleteSpace: useMutation({
      // #417 — `confirm` is the typed space name, required by the API whenever
      // the space still holds databases. Sent from the UI's typed-confirm dialog;
      // the API rejects the call without it, so the guard cannot be bypassed by
      // a caller that forgets to ask.
      mutationFn: async ({ id, confirm }: { id: string; confirm?: string }) =>
        unwrap<unknown>(
          await api.DELETE('/api/v1/workspaces/{ws}/spaces/{space}', {
            params: { path: { ws, space: id } },
            body: { confirm } as never,
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
        icon?: string | null;
        color?: string | null;
        space_id?: string;
        folder_id?: string | null;
        position?: number;
        /** #457 — the purpose line. `null` clears it; omitting it leaves it alone,
         *  which is `descriptionPatchSchema`'s contract, not this hook's. */
        description?: string | null;
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
            // The typed-name confirm already covers the destructive intent;
            // relations into a deleted database cannot outlive it.
            body: { confirm, sever_relations: true },
          }),
        ),
      onSuccess: invalidate,
    }),
  };
}
