'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { GRANT_ROLES } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { FreeGuestTip } from '@/components/free-guest-tip';
import { guestInviteHref } from '@/lib/guest-invite';

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
    onSuccess: (_data, input) => {
      posthog.capture('share_access_granted', {
        role: input.role,
        scope_type: scope.space_id ? 'space' : 'database',
      });
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

  // #530/#564 — workspace-wide members (admin + member), grouped separately
  // from guests below. Otto's ruling: individual-user grants only for v1, no
  // role/team grouping layer (access_grants' enforcement surface has already
  // leaked four times — #468/#469/#472/#474 — and a grouping abstraction on
  // top multiplies that surface). Grouping here is purely presentational
  // (Members vs Guests), not a new enforcement concept.
  const workspaceMembers = (members.data ?? []).filter((m) => m.role !== 'guest');

  return (
    <DialogContent title={`Access to “${scopeName}”`}>
      <div className="flex flex-col gap-4">
        {/*
          #564 — the old line stated the policy and stopped: "No guest access
          yet. Members and admins always have access." True, and kept below,
          but a dead end — it never said what to do about it. Ievgen's decision
          (recorded on #564): members stay workspace-wide by design (ADR-0009);
          the answer to "I don't want this member in this space" is a GUEST
          grant instead, and "I want them to contribute but not delete things"
          is exactly what Contributor is for — named here, not left implicit.
        */}
        <p className="text-[13px] text-muted">
          Members and admins always have access — that&rsquo;s fixed, not something to restrict here. To
          give someone narrower access, invite them as a <span className="font-medium text-ink">guest</span> below
          instead. Want them to add and edit records but never delete anything?{' '}
          <span className="font-medium text-ink">Contributor</span> is that level.
        </p>
        <FreeGuestTip
          dismissKey={`share-${scope.space_id ?? scope.database_id ?? scopeName}`}
          href={guestInviteHref({ ws, spaceId: scope.space_id })}
        >
          Viewer and commenter access is free, always (never a paid seat) — invite your client or
          collaborator here rather than adding them as a member.
        </FreeGuestTip>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Members</span>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {workspaceMembers.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between border-b border-border-default px-3 py-2 last:border-b-0"
              >
                <span className="truncate text-[13px] text-ink">{m.user.name}</span>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] capitalize text-muted">{m.role}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Guests</span>
          {scopeGrants.length === 0 ? (
            <p className="text-[13px] text-muted">No guests have access to this yet — add one below.</p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
              {scopeGrants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center justify-between border-b border-border-default px-3 py-2 last:border-b-0"
                >
                  <span className="truncate text-[13px] text-ink">{nameOf(grant.user_id)}</span>
                  <span className="flex shrink-0 items-center gap-2">
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
          )}
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
