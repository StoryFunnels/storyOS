'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import posthog from 'posthog-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { useSpaces, useWorkspace } from '@/lib/queries';
import { GRANT_ROLES } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { TypedConfirmName } from '@/components/ui/typed-confirm-name';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { MenuSelect } from '@/components/ui/menu-select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { AdvancedSection, SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsPill, SettingsRow } from '@/components/settings/settings-chrome';
import { useSession } from '@/lib/auth-client';
import { useDateFormat } from '@/lib/preferences';
import { inviteRowModel, invitationsSummary, sortInvites } from '@/lib/invite-state';
import { MEMBERS_COPY, ROLE_DESCRIPTIONS } from '@/lib/members-copy';
import { confirmRemoveMember, confirmRevokeInvite, confirmRoleChange, type WorkspaceRole } from '@/lib/settings-confirmations';
import { Label } from '@/components/ui/label';
import { FreeGuestTip } from '@/components/free-guest-tip';

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
  created_at?: string;
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

  const confirm = useConfirm();

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
  const { data: session } = useSession();
  const myUserId = session?.user?.id;
  const fmt = useDateFormat();
  const now = Date.now();
  const [eraseTarget, setEraseTarget] = useState<Member | null>(null);

  const people = members.data ?? [];
  const invitations = sortInvites(invites.data ?? [], now);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader
        title="Members"
        lead={workspace.data ? `${people.length} ${people.length === 1 ? 'person' : 'people'} in ${workspace.data.name}` : undefined}
        action={
          isAdmin && (
            <InviteDialog
              ws={ws}
              spaces={spaces.data ?? []}
              initialOpen={searchParams.get('invite') === 'guest'}
              initialRole={searchParams.get('invite') === 'guest' ? 'guest' : undefined}
              initialSpaceIds={searchParams.get('space') ? [searchParams.get('space')!] : undefined}
              initialGrantRole={searchParams.get('grant') ?? undefined}
            />
          )
        }
      />

      <SettingsPageBody>
        <SettingsBox>
          {people.map((member) => (
            <SettingsRow
              key={member.id}
              leading={<Avatar userId={member.user.id} name={member.user.name} image={member.user.image} size={24} />}
              title={
                <>
                  {member.user.name}
                  {member.user.id === myUserId && <span className="font-normal text-muted"> · you</span>}
                </>
              }
              description={member.user.email}
            >
              {isAdmin ? (
                <RoleMenu
                  role={member.role}
                  name={member.user.name}
                  onChange={async (to) => {
                    if (to === member.role) return;
                    if (await confirm(confirmRoleChange(member.user.name, member.role as WorkspaceRole, to))) updateMember.mutate({ id: member.id, role: to });
                  }}
                  onRemove={async () => {
                    if (await confirm(confirmRemoveMember(member.user.name))) removeMember.mutate(member.id);
                  }}
                />
              ) : (
                <span className="text-body capitalize text-muted">{member.role}</span>
              )}
            </SettingsRow>
          ))}
        </SettingsBox>

        {isAdmin && invitations.length > 0 && (
          <SettingsBox title="Invitations" aside={invitationsSummary(invitations, now)}>
            {invitations.map((invite) => (
              <InviteRow
                key={invite.id}
                ws={ws}
                invite={invite}
                now={now}
                date={(iso) => fmt.date(iso)}
                onRevoke={async () => {
                  if (await confirm(confirmRevokeInvite(invite.email))) revokeInvite.mutate(invite.id);
                }}
              />
            ))}
          </SettingsBox>
        )}

        {isAdmin && (
          <AdvancedSection title={MEMBERS_COPY.dataRequestsTitle} summary={MEMBERS_COPY.dataRequestsSummary}>
            <SettingsRow title={MEMBERS_COPY.exportTitle} description={MEMBERS_COPY.exportDescription}>
              <PersonPicker people={people} label="Export" disabled={exportMember.isPending} onPick={(m) => exportMember.mutate(m)} />
            </SettingsRow>
            <SettingsRow title={MEMBERS_COPY.eraseTitle} description={MEMBERS_COPY.eraseDescription}>
              <PersonPicker people={people} label="Erase" danger onPick={(m) => setEraseTarget(m)} />
            </SettingsRow>
          </AdvancedSection>
        )}
      </SettingsPageBody>

      <EraseMemberDialog
        ws={ws}
        member={eraseTarget}
        onClose={() => setEraseTarget(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['members', ws] })}
      />
    </div>
  );
}

const ROLE_ORDER: ReadonlyArray<{ value: WorkspaceRole; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'guest', label: 'Guest' },
];

/**
 * A person's role, as the product's own menu (the prototype's role menu, #974): each role says what it means, and Remove sits below a
 * rule, in the error colour, with its consequence in plain text. It replaces the old drop-down list (no native lists in Settings) and
 * the Remove button whose only explanation was a tooltip.
 */
function RoleMenu({
  role,
  name,
  onChange,
  onRemove,
}: {
  role: string;
  name: string;
  onChange: (to: WorkspaceRole) => void;
  onRemove: () => void;
}) {
  const current = ROLE_ORDER.find((r) => r.value === role)?.label ?? role;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Role of ${name}: ${current}`}
          className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] border border-transparent pl-[9px] pr-1.5 text-label font-medium text-ink hover:bg-hover data-[state=open]:bg-hover"
        >
          {current}
          <ChevronDown className="h-[11px] w-[11px] text-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[272px]">
        {ROLE_ORDER.map((r) => (
          <DropdownMenuItem key={r.value} onSelect={() => onChange(r.value)} className="items-start">
            <span className="mt-px w-[13px] shrink-0 text-primary-text">{r.value === role && <Check className="h-[13px] w-[13px]" aria-hidden />}</span>
            <span className="min-w-0">
              <b className="block text-body font-medium text-ink">{r.label}</b>
              <span className="block text-meta leading-[1.4] text-muted">{ROLE_DESCRIPTIONS[r.value]}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRemove} className="items-start">
          <span className="w-[13px] shrink-0" />
          <span className="min-w-0">
            <b className="block text-body font-medium text-error">{MEMBERS_COPY.removeTitle}</b>
            <span className="block text-meta leading-[1.4] text-muted">{MEMBERS_COPY.removeDescription}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Choose person…": the one picker both data requests use, so Export and Erase name their subject before anything runs. */
function PersonPicker({
  people,
  label,
  danger,
  disabled,
  onPick,
}: {
  people: Member[];
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onPick: (member: Member) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled} aria-label={`${label}: choose a person`} className={danger ? 'text-error' : undefined}>
          {MEMBERS_COPY.choosePerson}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
        {people.length === 0 && <p className="px-2 py-1.5 text-label text-muted">{MEMBERS_COPY.noOneToChoose}</p>}
        {people.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => onPick(m)} className="flex-col items-start gap-0">
            <span className="max-w-full truncate text-body text-ink">{m.user.name}</span>
            {m.user.email && <span className="max-w-full truncate text-meta text-muted">{m.user.email}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One invitation. An expired one SAYS so ("Expired 25 Aug") and offers Send again first: the link it holds is dead. Sending again
 * issues a fresh link and a fresh week (`POST /invites/:id/resend`), which turns the row back to Pending on the refetch.
 */
function InviteRow({
  ws,
  invite,
  now,
  date,
  onRevoke,
}: {
  ws: string;
  invite: Invite;
  now: number;
  date: (iso: string) => string;
  onRevoke: () => void;
}) {
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const model = inviteRowModel(invite, now, date);

  const resend = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/invites/{invite}/resend',
        { params: { path: { ws, invite: invite.id } } },
      );
      if (error) throw error;
      return data as unknown as { accept_url: string };
    },
    onSuccess: (data) => {
      setLink(data.accept_url);
      toast.success('Invitation sent');
      void qc.invalidateQueries({ queryKey: ['invites', ws] });
    },
    // 429 = resend cooldown; surface the server's "wait a minute" message.
    onError: (err: unknown) => {
      const message =
        (err as { error?: { message?: string } })?.error?.message ??
        (err as { message?: string })?.message ??
        'Could not resend invitation';
      toast.error(message);
    },
  });

  return (
    <SettingsRow
      title={invite.email}
      description={link ? `${model.detail} · ${MEMBERS_COPY.copyLinkDescription}` : model.detail}
    >
      <SettingsPill tone={model.state === 'expired' ? 'warn' : 'neutral'}>{model.pill}</SettingsPill>
      {link && (
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(link);
            toast.success('Copied');
          }}
        >
          Copy link
        </Button>
      )}
      <Button
        variant={model.resendIsPrimary ? 'primary' : 'secondary'}
        size="sm"
        aria-label={model.resendAriaLabel}
        onClick={() => resend.mutate()}
        disabled={resend.isPending}
      >
        {model.resendLabel}
      </Button>
      <Button variant="secondary" size="sm" onClick={onRevoke}>
        Revoke
      </Button>
    </SettingsRow>
  );
}

/** Erase one person from this workspace. Controlled: the Data requests picker chooses who, this asks for the typed confirmation. */
function EraseMemberDialog({
  ws,
  member,
  onClose,
  onDone,
}: {
  ws: string;
  member: Member | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const target = member ? (member.user.email ?? member.user.name) : '';

  const erase = useMutation({
    mutationFn: async () => {
      if (!member) return;
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/members/{member}/gdpr/anonymize',
        { params: { path: { ws, member: member.id } } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${member?.user.name ?? 'The person'} was erased from this workspace`);
      setConfirm('');
      onClose();
      onDone();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not erase this person. Nothing changed.')),
  });

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next) {
          setConfirm('');
          onClose();
        }
      }}
    >
      {member && (
        <DialogContent title="Erase this person from this workspace (GDPR)">
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink-secondary">
              This removes <span className="font-medium text-ink">{member.user.name}</span> and their data from{' '}
              <span className="font-medium text-ink">this workspace only</span>: their membership and access here, their
              per-person settings, and the API tokens minted for this workspace.
            </p>
            <p className="text-body text-ink-secondary">
              Their <span className="font-medium text-ink">account stays untouched</span>: their sign-in and every other
              workspace keep working. Their comments and history here stay in place under their name. Deleting a whole
              account is the person&rsquo;s own choice, under <span className="font-medium text-ink">Settings → Account</span>.{' '}
              <span className="font-medium">This cannot be undone here</span>: to give them access again, invite them again.
            </p>
            <div className="flex flex-col gap-1.5">
              <TypedConfirmName name={target} />
              <Input
                id="erase-confirm"
                aria-label={`Type ${target} to confirm`}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
              />
              {/* #801 — same class of bug as confirm-dialog.tsx: strict,
                  untrimmed match with no feedback on a mismatch. */}
              {confirm.trim().length > 0 && confirm.trim() !== target.trim() && (
                <p className="text-label text-error">Doesn&rsquo;t match — check spelling and capitalization.</p>
              )}
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
                disabled={confirm.trim() !== target.trim() || erase.isPending}
                onClick={() => erase.mutate()}
              >
                Erase from this workspace
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
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
  // #327: 'viewer', not 'editor'. This is the LAST guest-invite entry point —
  // fixing the three deep links but leaving the dialog's own default billable
  // would just move the bug, and it would contradict the free-guest tip shown
  // directly above this control. An admin can still raise it deliberately.
  const [grantRole, setGrantRole] = useState(initialGrantRole ?? 'viewer');
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
      posthog.capture('invite_sent', { role });
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
            <p className="text-body text-ink-secondary">
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
            {/*
             * #330: #99 shipped this tip on the share dialog and the form view
             * but not here — the one surface onboarding actually deep-links
             * into. Someone arriving from "invite your client" saw role and
             * access controls and nothing about cost, which is exactly the
             * moment the reassurance is worth something. No `href`: the link
             * would point at this dialog.
             */}
            {role === 'guest' && (
              <FreeGuestTip dismissKey={`members-invite-${ws}`}>
                Viewer and commenter guests are free, always — never a paid seat. Scope them to the
                spaces they need below.
              </FreeGuestTip>
            )}
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
              <Label>Role</Label>
              <MenuSelect
                label="Role"
                value={role}
                onChange={(next) => setRole(next as typeof role)}
                className="h-9 w-full max-w-none"
                menuClassName="w-[22rem] max-w-[calc(100vw-3rem)]"
                options={[
                  { value: 'member', label: 'Member — full access' },
                  { value: 'admin', label: 'Admin — settings & members' },
                  { value: 'guest', label: 'Guest — access to chosen spaces only' },
                ]}
              />
            </div>
            {role === 'guest' && (
              <div className="flex flex-col gap-1.5">
                <Label>Access level</Label>
                <MenuSelect
                  label="Access level"
                  value={grantRole}
                  onChange={setGrantRole}
                  className="h-9 w-full max-w-none"
                  menuClassName="w-[22rem] max-w-[calc(100vw-3rem)]"
                  options={GRANT_ROLES.map((r) => ({ value: r.value, label: r.label }))}
                />
                <Label>Spaces they can access</Label>
                <div className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-border-default bg-card p-2">
                  {spaces.map((space) => (
                    <label key={space.id} className="flex items-center gap-2 text-body text-ink">
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
