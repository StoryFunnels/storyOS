'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { GRANT_ROLES } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

interface Grant {
  id: string;
  user_id: string;
  space_id: string | null;
  database_id: string | null;
  role: string;
}

interface Member {
  id: string;
  role: string;
  user_id: string;
  user: { id: string; name: string; email: string | null };
}

/**
 * Admin Share dialog (ADR-0007): grants on ONE scope — a space or a database.
 * Guests listed with their role here; add/change/revoke.
 */
export function ShareDialog({
  ws,
  scope,
  scopeName,
}: {
  ws: string;
  scope: { space_id?: string; database_id?: string };
  scopeName: string;
}) {
  const qc = useQueryClient();

  const grants = useQuery({
    queryKey: ['grants', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/grants', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return (data as unknown as { data: Grant[] }).data;
    },
  });

  const members = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as Member[];
    },
  });

  const guests = (members.data ?? []).filter((m) => m.role === 'guest');
  const scopeGrants = (grants.data ?? []).filter(
    (g) =>
      (scope.space_id && g.space_id === scope.space_id) ||
      (scope.database_id && g.database_id === scope.database_id),
  );
  const nameOf = (userId: string) =>
    (members.data ?? []).find((m) => m.user_id === userId)?.user.name ?? userId.slice(0, 8);

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('editor');

  const addGrant = useMutation({
    mutationFn: async (input: { user_id: string; role: string }) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/grants', {
        params: { path: { ws } },
        body: { user_id: input.user_id, role: input.role, ...scope } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['grants', ws] });
      setUserId('');
    },
    onError: () => toast.error('Could not save the grant'),
  });

  const removeGrant = useMutation({
    mutationFn: async (grantId: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/grants/{grant}', {
        params: { path: { ws, grant: grantId } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['grants', ws] }),
  });

  return (
    <DialogContent title={`Access to “${scopeName}”`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          {scopeGrants.length === 0 && (
            <p className="text-[13px] text-muted">No guest access yet. Members and admins always have access.</p>
          )}
          {scopeGrants.map((grant) => (
            <div
              key={grant.id}
              className="flex items-center justify-between rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2"
            >
              <span className="text-[13px] text-ink">{nameOf(grant.user_id)}</span>
              <span className="flex items-center gap-2">
                <select
                  className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                  value={grant.role}
                  onChange={(e) => addGrant.mutate({ user_id: grant.user_id, role: e.target.value })}
                >
                  {GRANT_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.value}
                    </option>
                  ))}
                </select>
                <button className="text-faint hover:text-error" onClick={() => removeGrant.mutate(grant.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>

        {guests.length > 0 ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (userId) addGrant.mutate({ user_id: userId, role });
            }}
          >
            <Label>Add a guest</Label>
            <div className="flex gap-2">
              <select
                className="h-9 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="" disabled>
                  Pick a person…
                </option>
                {guests.map((g) => (
                  <option key={g.user_id} value={g.user_id}>
                    {g.user.name}
                  </option>
                ))}
              </select>
              <select
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {GRANT_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.value}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" disabled={!userId}>
                Add
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-[12px] text-muted">
            No guests in this workspace yet — invite one from Settings → Members first.
          </p>
        )}

        <div className="flex justify-end">
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </div>
      </div>
    </DialogContent>
  );
}
