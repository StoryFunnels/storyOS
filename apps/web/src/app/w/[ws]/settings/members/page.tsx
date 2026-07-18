'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { useSpaces, useWorkspace } from '@/lib/queries';
import { GRANT_ROLES } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Member {
  id: string;
  role: 'admin' | 'member' | 'guest';
  space_ids: string[] | null;
  user: { id: string; name: string; email: string | null; image: string | null };
}
interface Invite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
}

export default function MembersPage() {
  return (
    <Suspense>
      <MembersPageContent />
    </Suspense>
  );
}

function MembersPageContent() {
  const { ws } = useParams<{ ws: string }>();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const workspace = useWorkspace(ws);
  const spaces = useSpaces(ws);

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

  const invites = useQuery({
    queryKey: ['invites', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/invites', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as Invite[];
    },
    enabled: workspace.data?.role === 'admin',
  });

  const updateMember = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/members/{member}', {
        params: { path: { ws, member: id } },
        body: { role: role as 'admin' | 'member' | 'guest' },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', ws] }),
    // MN-190: a promotion can 402 on a Free plan at its seat ceiling — that
    // message ("upgrade to Pro...") is the useful one, not a generic guess.
    onError: (err: unknown) => {
      const message =
        (err as { error?: { message?: string } })?.error?.message ??
        'Could not change role (last admin?)';
      toast.error(message);
    },
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/members/{member}', {
        params: { path: { ws, member: id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', ws] }),
    onError: () => toast.error('Could not remove member (last admin?)'),
  });

  const revokeInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/invites/{invite}', {
        params: { path: { ws, invite: id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', ws] }),
  });

  const exportMember = useMutation({
    mutationFn: async (member: Member) => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/members/{member}/gdpr/export',
        { params: { path: { ws, member: member.id } } },
      );
      if (error) throw error;
      const blob = new Blob(
        [JSON.stringify({ ...data, exported_at: new Date().toISOString() }, null, 2)],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `storyos-data-export-${member.user.email ?? member.user.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast.success('Data exported'),
    onError: () => toast.error('Export failed'),
  });

  const isAdmin = workspace.data?.role === 'admin';

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Members</h1>
        {isAdmin && (
          <InviteDialog
            ws={ws}
            spaces={spaces.data ?? []}
            initialOpen={searchParams.get('invite') === 'guest'}
            initialRole={searchParams.get('invite') === 'guest' ? 'guest' : undefined}
            initialSpaceIds={searchParams.get('space') ? [searchParams.get('space')!] : undefined}
            initialGrantRole={searchParams.get('grant') ?? undefined}
          />
        )}
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {(members.data ?? []).map((member) => (
          <div
            key={member.id}
            className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Avatar userId={member.user.id} name={member.user.name} image={member.user.image} size={32} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{member.user.name}</p>
                <p className="truncate text-[13px] text-muted">{member.user.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin ? (
                <>
                  <select
                    className="h-7 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                    value={member.role}
                    onChange={(e) => updateMember.mutate({ id: member.id, role: e.target.value })}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => exportMember.mutate(member)}
                    disabled={exportMember.isPending}
                    title="Export everything held about this member (GDPR)"
                  >
                    Export
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeMember.mutate(member.id)}>
                    Remove
                  </Button>
                  <EraseMemberDialog ws={ws} member={member} onDone={() => void qc.invalidateQueries({ queryKey: ['members', ws] })} />
                </>
              ) : (
                <span className="text-[13px] capitalize text-muted">{member.role}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {isAdmin && (invites.data?.length ?? 0) > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold text-ink">Pending invites</h2>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {(invites.data ?? []).map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
              >
                <div>
                  <p className="text-sm text-ink">{invite.email}</p>
                  <p className="text-[13px] capitalize text-muted">{invite.role}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revokeInvite.mutate(invite.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EraseMemberDialog({
  ws,
  member,
  onDone,
}: {
  ws: string;
  member: Member;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const target = member.user.email ?? member.user.name;

  const erase = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/members/{member}/gdpr/anonymize',
        { params: { path: { ws, member: member.id } } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Member erased and anonymized');
      setOpen(false);
      setConfirm('');
      onDone();
    },
    onError: () => toast.error('Could not erase (last admin?)'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirm('');
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Erase
        </Button>
      </DialogTrigger>
      <DialogContent title="Erase this member (GDPR)">
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-ink-secondary">
            This fulfils a data-subject erasure. It permanently wipes{' '}
            <span className="font-medium text-ink">{member.user.name}</span>&rsquo;s
            identity to an anonymous tombstone, destroys their sessions, sign-in
            credentials, and API tokens, and removes their access to this
            workspace. Their comments and history stay in place but are no longer
            attributed to a real person. <span className="font-medium">This cannot be undone.</span>
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="erase-confirm">
              Type <span className="font-medium text-ink">{target}</span> to confirm
            </Label>
            <Input
              id="erase-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={confirm !== target || erase.isPending}
              onClick={() => erase.mutate()}
            >
              Erase permanently
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  ws,
  spaces,
  initialOpen,
  initialRole,
  initialSpaceIds,
  initialGrantRole,
}: {
  ws: string;
  spaces: Array<{ id: string; name: string }>;
  initialOpen?: boolean;
  initialRole?: 'admin' | 'member' | 'guest';
  initialSpaceIds?: string[];
  initialGrantRole?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(initialOpen ?? false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'guest'>(initialRole ?? 'member');
  const [spaceIds, setSpaceIds] = useState<string[]>(initialSpaceIds ?? []);
  const [grantRole, setGrantRole] = useState(initialGrantRole ?? 'editor');
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/invites', {
        params: { path: { ws } },
        body: {
          email,
          role,
          ...(role === 'guest'
            ? { grants: spaceIds.map((id) => ({ space_id: id, role: grantRole })) }
            : {}),
        } as never,
      });
      if (error) throw error;
      return data as unknown as { accept_url: string };
    },
    onSuccess: (data) => {
      setAcceptUrl(data.accept_url);
      void qc.invalidateQueries({ queryKey: ['invites', ws] });
    },
    onError: (err: unknown) => {
      const message =
        (err as { error?: { message?: string } })?.error?.message ??
        (err as { message?: string })?.message ??
        'Invite failed — please try again';
      toast.error(message);
    },
  });

  function reset() {
    setEmail('');
    setRole('member');
    setSpaceIds([]);
    setAcceptUrl(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Invite</Button>
      </DialogTrigger>
      <DialogContent title="Invite to workspace">
        {acceptUrl ? (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-ink-secondary">
              Invite created. Share this link (also emailed when SMTP is configured):
            </p>
            <div className="flex gap-2">
              <Input readOnly value={acceptUrl} onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(acceptUrl);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
            </div>
            <div className="flex justify-end">
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="member">Member — full access</option>
                <option value="admin">Admin — settings & members</option>
                <option value="guest">Guest — access to chosen spaces only</option>
              </select>
            </div>
            {role === 'guest' && (
              <div className="flex flex-col gap-1.5">
                <Label>Access level</Label>
                <select
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={grantRole}
                  onChange={(e) => setGrantRole(e.target.value)}
                >
                  {GRANT_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Label>Spaces they can access</Label>
                <div className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-border-default bg-card p-2">
                  {spaces.map((space) => (
                    <label key={space.id} className="flex items-center gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        checked={spaceIds.includes(space.id)}
                        onChange={(e) =>
                          setSpaceIds((prev) =>
                            e.target.checked
                              ? [...prev, space.id]
                              : prev.filter((id) => id !== space.id),
                          )
                        }
                      />
                      {space.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  {initialOpen ? 'Skip for now' : 'Cancel'}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={invite.isPending || (role === 'guest' && spaceIds.length === 0)}>
                Send invite
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
