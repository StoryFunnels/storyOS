'use client';

import posthog from 'posthog-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { isGrantRole } from '@/lib/access-model';
import type { Grant, GrantRole, Person, WorkspaceRole } from '@/lib/access-model';

/** #924 — the Manage access dialog's reads and writes, over the API that already exists (ADR-0018 phases 0–3, #943–#946). */
interface GrantRow {
  id: string;
  user_id: string;
  space_id: string | null;
  database_id: string | null;
  record_id?: string | null;
  role: string;
}

interface MemberRow {
  role: string;
  user_id: string;
  user: { id: string; name: string };
}

const grantsKey = (ws: string) => ['grants', ws] as const;
const membersKey = (ws: string) => ['members', ws] as const;

export function useAccessPeopleAndGrants(ws: string) {
  const grants = useQuery({
    queryKey: grantsKey(ws),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/grants', { params: { path: { ws } } });
      if (error) throw error;
      return (data as unknown as { data: GrantRow[] }).data;
    },
  });
  const members = useQuery({
    queryKey: membersKey(ws),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', { params: { path: { ws } } });
      if (error) throw error;
      return data as unknown as MemberRow[];
    },
  });
  const people: Person[] = (members.data ?? []).map((m) => ({
    userId: m.user_id,
    name: m.user.name,
    workspaceRole: (m.role === 'admin' || m.role === 'guest' ? m.role : 'member') as WorkspaceRole,
  }));
  // Record-scoped grants are not part of this dialog (a member's is refused by the API, ADR-0018 §7).
  const rows: Grant[] = (grants.data ?? []).flatMap((g) =>
    g.record_id || !isGrantRole(g.role)
      ? []
      : [{ id: g.id, userId: g.user_id, role: g.role as GrantRole, spaceId: g.space_id, databaseId: g.database_id }],
  );
  return { people, grants: rows, isPending: grants.isPending || members.isPending, isError: grants.isError || members.isError };
}

export type AccessScope = { space_id: string } | { database_id: string };

export function useAccessMutations(ws: string, scope: AccessScope) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: grantsKey(ws) });
    void qc.invalidateQueries({ queryKey: ['spaces', ws] });
    void qc.invalidateQueries({ queryKey: ['databases', ws] });
    void qc.invalidateQueries({ queryKey: ['database', ws] });
  };

  const grant = useMutation({
    mutationFn: async (input: { userId: string; role: GrantRole }) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/grants', {
        params: { path: { ws } },
        body: { user_id: input.userId, role: input.role, ...scope } as never,
      });
      if (error) throw error;
    },
    onSuccess: (_data, input) => {
      // The event the dashboards already read (the old guests-only dialog sent it); a role change and a "keep" count as grants too.
      posthog.capture('share_access_granted', { role: input.role, scope_type: 'space_id' in scope ? 'space' : 'database' });
      refresh();
    },
    onError: () => toast.error('Could not save that. Nothing changed.'),
  });

  const revoke = useMutation({
    mutationFn: async (grantId: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/grants/{grant}', { params: { path: { ws, grant: grantId } } });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: () => toast.error('Could not remove that. Nothing changed.'),
  });

  const setRestricted = useMutation({
    mutationFn: async (restricted: boolean) => {
      const body = { restricted } as never;
      const res =
        'space_id' in scope
          ? await api.PATCH('/api/v1/workspaces/{ws}/spaces/{space}', { params: { path: { ws, space: scope.space_id } }, body } as never)
          : await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}', { params: { path: { ws, db: scope.database_id } }, body } as never);
      if (res.error) throw res.error;
    },
    onSuccess: refresh,
    onError: () => toast.error('Could not change who can see this. Nothing changed.'),
  });

  return { grant, revoke, setRestricted };
}
