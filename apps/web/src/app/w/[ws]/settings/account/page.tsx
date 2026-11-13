'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL, api, apiErrorMessage } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { useDateFormat } from '@/lib/preferences';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { DELETE_ACCOUNT_BLOCKER, DELETE_ACCOUNT_CONSEQUENCES, ERASE_ME_BODY, emailConfirmMatches } from '@/lib/erase-account';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { confirmRemovePhoto, confirmRevokeSession } from '@/lib/settings-confirmations';
import { removeProfilePhoto } from '@/lib/remove-photo';
import { Label } from '@/components/ui/label';
import {
  AdvancedSection,
  SettingsBox,
  SettingsPageBody,
  SettingsPageHeader,
  SettingsPill,
  SettingsRow,
} from '@/components/settings/settings-chrome';
import { cn } from '@/lib/utils';

/** The Settings pages' field label: the prototype's 12px semibold, one step under the field it labels (#974 design). */
const FIELD_LABEL = 'text-label font-semibold';

/** Downscale to a 256px cover-crop PNG before upload (matches account-menu.tsx). */
async function resizeTo256(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

interface SessionRow {
  token: string;
  createdAt: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

/**
 * Profile (ticket #1189, Dara's #974 design): who you are (photo, name, email, one Save) and your password sit on the page; the
 * power controls (the devices you are signed in on, and erasing the account) sit under a labelled "Advanced". Nothing was removed:
 * every control the page had is still here, the rare ones one click further.
 */
export default function AccountPage() {
  const { data: session, refetch } = useSession();
  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as SessionRow[];
    },
    enabled: Boolean(session),
  });

  if (!session) return <div className="p-4 text-body text-muted sm:p-8">Loading…</div>;

  const others = (sessions.data ?? []).filter((s) => s.token !== session.session.token).length;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Profile" lead="How you appear to everyone in your workspaces" />

      <SettingsPageBody>
        <ProfileBox
          userId={session.user.id}
          name={session.user.name}
          image={session.user.image ?? null}
          email={session.user.email}
          verified={session.user.emailVerified}
          onChange={() => void refetch()}
        />
        <PasswordBox />
        <AdvancedSection
          title="Sessions and account"
          summary={sessions.data ? `${others} other session${others === 1 ? '' : 's'}` : 'your devices, and deleting your account'}
        >
          <SessionsRows rows={sessions.data ?? []} currentToken={session.session.token} loading={sessions.isLoading} />
          <DeleteAccountRow email={session.user.email} />
        </AdvancedSection>
      </SettingsPageBody>
    </div>
  );
}

/** The photo, the name and the email are one box with one Save, as drawn. The photo saves as soon as it is chosen. */
function ProfileBox({
  userId,
  name,
  image,
  email,
  verified,
  onChange,
}: {
  userId: string;
  name: string;
  image: string | null;
  email: string;
  verified: boolean;
  onChange: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const current = override !== undefined ? override : image;
  const imageUrl = current ? (current.startsWith('/') ? `${API_URL}${current}` : current) : null;
  const confirm = useConfirm();

  async function upload(file: File) {
    try {
      const blob = await resizeTo256(file);
      const form = new FormData();
      form.append('file', blob, 'avatar.png');
      const res = await fetch(`${API_URL}/api/v1/users/me/avatar`, { method: 'POST', credentials: 'include', body: form });
      if (!res.ok) throw new Error();
      const { image: next } = (await res.json()) as { image: string };
      setOverride(next);
      onChange();
      toast.success('Photo updated');
    } catch {
      toast.error('Could not upload the photo');
    }
  }

  async function remove() {
    if (!(await confirm(confirmRemovePhoto()))) return;
    // Ticket #1190 (parity row Account #3): a failed removal must say so. The logic is in lib/remove-photo.ts so a test can fail it.
    const removed = await removeProfilePhoto(() => fetch(`${API_URL}/api/v1/users/me/avatar`, { method: 'DELETE', credentials: 'include' }), toast);
    if (removed) {
      setOverride(null);
      onChange();
    }
  }

  const [draft, setDraft] = useState(name);
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({ name: draft.trim() });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      onChange();
      toast.success('Name updated');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not update name'),
  });
  const dirty = draft.trim() !== '' && draft.trim() !== name;

  return (
    <SettingsBox>
      {/* Not a SettingsRow: the picture sits beside BOTH lines of text, on a phone too, which the row's `leading` slot does not do. */}
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2 text-body">
        <Avatar userId={userId} name={name} image={imageUrl} size={40} />
        <div className="flex min-w-0 flex-1 flex-col leading-[1.35]">
          <b className="font-medium text-ink">Photo</b>
          <span className="text-label leading-[1.35]! text-muted">PNG, JPG or WebP, up to 1 MB</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>button]:flex-1">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            {imageUrl ? 'Change' : 'Upload'}
          </Button>
          {imageUrl && (
            <Button variant="secondary" size="sm" onClick={remove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5 border-t border-border-default px-3.5 py-3">
          <Label htmlFor="display-name" className={FIELD_LABEL}>
            Name
          </Label>
          <Input id="display-name" size="sm" value={draft} onChange={(e) => setDraft(e.target.value)} required className="max-w-[420px]" />
          <span className="text-label text-muted">How you appear across the workspace.</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3.5 pb-3">
          <span className={cn(FIELD_LABEL, 'text-ink-secondary')}>Email</span>
          <span className="flex flex-wrap items-center gap-2 text-body text-ink">
            {email}
            <SettingsPill tone={verified ? 'ok' : 'neutral'}>{verified ? 'Verified' : 'Unverified'}</SettingsPill>
          </span>
          <span className="text-label text-muted">Changing your email will be available soon.</span>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border-default px-3.5 py-2.5">
          <Button type="submit" disabled={save.isPending || !dirty}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </SettingsBox>
  );
}

function PasswordBox() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setCurrent('');
      setNext('');
      toast.success('Password changed');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not change password'),
  });

  return (
    <SettingsBox title="Password">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next.length >= 8) change.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5 px-3.5 py-3">
          <Label htmlFor="cur-pw" className={FIELD_LABEL}>
            Current password
          </Label>
          <Input id="cur-pw" size="sm" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required className="max-w-[420px]" />
          <Label htmlFor="new-pw" className={cn(FIELD_LABEL, 'mt-1.5')}>
            New password
          </Label>
          <Input
            id="new-pw"
            size="sm"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={8}
            required
            className="max-w-[420px]"
          />
          <span className="text-label text-muted">At least 8 characters. Changing it signs you out everywhere else.</span>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border-default px-3.5 py-2.5">
          <Button type="submit" variant="secondary" disabled={change.isPending || !current || next.length < 8}>
            Change password
          </Button>
        </div>
      </form>
    </SettingsBox>
  );
}

/** The devices you are signed in on. Signing one out confirms (ticket #1093) and names the device; this device has no button. */
function SessionsRows({ rows, currentToken, loading }: { rows: SessionRow[]; currentToken: string; loading: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const fmt = useDateFormat();

  const revoke = useMutation({
    mutationFn: async (token: string) => {
      const { error } = await authClient.revokeSession({ token });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auth-sessions'] }),
    onError: (e: Error) => toast.error(e.message || 'Could not sign that device out'),
  });

  const sorted = rows.slice().sort((a, b) => (a.token === currentToken ? -1 : b.token === currentToken ? 1 : 0));

  return (
    <>
      {sorted.length === 0 && (
        <SettingsRow
          title={loading ? 'Loading…' : 'No other sessions'}
          description={loading ? undefined : 'You are signed in on this device only.'}
        />
      )}
      {sorted.map((s) => {
        const isCurrent = s.token === currentToken;
        const device = describeAgent(s.userAgent);
        const ip = s.ipAddress || 'unknown IP';
        return (
          <SettingsRow
            key={s.token}
            title={
              <>
                {device}
                {isCurrent && <span className="ml-2 text-label font-normal text-success">This device</span>}
              </>
            }
            description={`${ip} · signed in ${fmt.dateTime(s.createdAt)}`}
          >
            {!isCurrent && (
              <Button
                variant="secondary"
                size="sm"
                disabled={revoke.isPending}
                onClick={async () => {
                  if (await confirm(confirmRevokeSession(device, ip))) revoke.mutate(s.token);
                }}
              >
                Sign out
              </Button>
            )}
          </SettingsRow>
        );
      })}
    </>
  );
}

function describeAgent(ua?: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg/.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * #1039 — erase YOUR OWN account everywhere. Self-service and session-only (the API refuses a token), irreversible, and blocked
 * while you are the only admin of a workspace (409, whose own sentence is shown). A workspace admin can only remove a person from
 * THEIR workspace; this is the one way to delete the account itself.
 */
function DeleteAccountRow({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);

  const erase = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/me/gdpr/erase', { body: ERASE_ME_BODY } as never);
      if (error) throw error;
    },
    onSuccess: async () => {
      // The server has destroyed the session; clear what is left in this browser and start from the sign-in page.
      try {
        await authClient.signOut();
      } catch {
        // already signed out by the erase itself
      }
      window.location.assign('/login');
    },
    onError: (error) => setBlocked(apiErrorMessage(error, 'Could not delete your account. Nothing was changed.')),
  });

  return (
    <SettingsRow
      title="Delete my account"
      description="Erases your account and removes you from every workspace. This can’t be undone, and it is separate from a workspace admin removing you from one workspace."
    >
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped('');
            setBlocked(null);
          }
        }}
      >
        <DialogTrigger asChild>
          {/* Ticket #1283 item 4: the trigger sits in a row, so it is a quiet button with red words, the same as Erase a person on Members and
              Uninstall on Packs; the filled red-bordered `destructive` look is for the confirm button inside the dialog. */}
          <Button variant="secondary" size="sm" className="text-error">
            Delete my account…
          </Button>
        </DialogTrigger>
        <DialogContent title="Delete your account?">
          <div className="flex flex-col gap-4">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body text-ink-secondary">
              {DELETE_ACCOUNT_CONSEQUENCES.map((line) => (
                <li key={line} className={line.startsWith('This cannot') ? 'font-medium text-ink' : undefined}>
                  {line}
                </li>
              ))}
            </ul>
            <p className="rounded-[var(--radius-control)] bg-hover px-3 py-2 text-label text-ink-secondary">{DELETE_ACCOUNT_BLOCKER}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-account-confirm">
                Type <span className="font-mono text-ink">{email}</span> to confirm
              </Label>
              <Input
                id="delete-account-confirm"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              {typed.trim().length > 0 && !emailConfirmMatches(typed, email) && (
                <p className="text-label text-error">Doesn&rsquo;t match your email — check the spelling.</p>
              )}
            </div>
            {blocked && (
              <p role="alert" className="rounded-[var(--radius-control)] border border-error px-3 py-2 text-body text-error">
                {blocked}
              </p>
            )}
            <div className="flex justify-end gap-2 max-md:flex-col-reverse">
              <DialogClose asChild>
                <Button type="button" variant="secondary" disabled={erase.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={!emailConfirmMatches(typed, email) || erase.isPending}
                onClick={() => {
                  setBlocked(null);
                  erase.mutate();
                }}
              >
                {erase.isPending ? 'Deleting…' : 'Delete my account permanently'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsRow>
  );
}
