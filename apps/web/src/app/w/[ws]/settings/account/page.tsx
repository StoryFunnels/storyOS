'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { useDateFormat } from '@/lib/preferences';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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

export default function AccountPage() {
  const { data: session, refetch } = useSession();

  if (!session) return <div className="p-8 text-[13px] text-muted">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Account</h1>
      <p className="mb-6 text-[13px] text-muted">Manage your profile and sign-in details.</p>

      <div className="flex flex-col gap-8">
        <PhotoSection
          userId={session.user.id}
          name={session.user.name}
          image={session.user.image ?? null}
          onChange={() => void refetch()}
        />
        <NameSection currentName={session.user.name} onSaved={() => void refetch()} />
        <EmailSection email={session.user.email} verified={session.user.emailVerified} />
        <PasswordSection />
        <SessionsSection currentToken={session.session.token} />
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border-default pb-8 last:border-b-0 last:pb-0">
      <h2 className="mb-1 text-sm font-medium text-ink">{title}</h2>
      {description && <p className="mb-3 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

function PhotoSection({
  userId,
  name,
  image,
  onChange,
}: {
  userId: string;
  name: string;
  image: string | null;
  onChange: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const current = override !== undefined ? override : image;
  const imageUrl = current ? (current.startsWith('/') ? `${API_URL}${current}` : current) : null;

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
    await fetch(`${API_URL}/api/v1/users/me/avatar`, { method: 'DELETE', credentials: 'include' });
    setOverride(null);
    onChange();
  }

  return (
    <Section title="Photo" description="PNG, JPG or WebP, up to 1MB.">
      <div className="flex items-center gap-4">
        <Avatar userId={userId} name={name} image={imageUrl} size={64} />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            {imageUrl ? 'Change' : 'Upload'}
          </Button>
          {imageUrl && (
            <Button variant="ghost" size="sm" onClick={remove}>
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
    </Section>
  );
}

function NameSection({ currentName, onSaved }: { currentName: string; onSaved: () => void }) {
  const [name, setName] = useState(currentName);
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({ name: name.trim() });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      onSaved();
      toast.success('Name updated');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not update name'),
  });

  return (
    <Section title="Name" description="How you appear across the workspace.">
      <form
        className="flex max-w-sm items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== currentName) save.mutate();
        }}
      >
        <div className="flex-1">
          <Label htmlFor="display-name">Display name</Label>
          <Input id="display-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <Button type="submit" disabled={save.isPending || !name.trim() || name.trim() === currentName}>
          Save
        </Button>
      </form>
    </Section>
  );
}

function EmailSection({ email, verified }: { email: string; verified: boolean }) {
  return (
    <Section title="Email" description="Changing your email will be available soon.">
      <div className="flex items-center gap-2 text-sm text-ink">
        {email}
        <span
          className={`rounded-[var(--radius-pill,9999px)] px-2 py-0.5 text-[11px] font-medium ${
            verified ? 'bg-accent-soft text-warning' : 'bg-hover text-muted'
          }`}
        >
          {verified ? 'Verified' : 'Unverified'}
        </span>
      </div>
    </Section>
  );
}

function PasswordSection() {
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
    <Section title="Password" description="Changing it signs out your other sessions.">
      <form
        className="flex max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next.length >= 8) change.mutate();
        }}
      >
        <div>
          <Label htmlFor="cur-pw">Current password</Label>
          <Input id="cur-pw" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="new-pw">New password</Label>
          <Input
            id="new-pw"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={8}
            required
          />
          <p className="mt-1 text-[12px] text-faint">At least 8 characters.</p>
        </div>
        <div>
          <Button type="submit" disabled={change.isPending || !current || next.length < 8}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

interface SessionRow {
  token: string;
  createdAt: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

function SessionsSection({ currentToken }: { currentToken: string }) {
  const qc = useQueryClient();
  const fmt = useDateFormat();
  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as SessionRow[];
    },
  });

  const revoke = useMutation({
    mutationFn: async (token: string) => {
      const { error } = await authClient.revokeSession({ token });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auth-sessions'] }),
    onError: (e: Error) => toast.error(e.message || 'Could not revoke session'),
  });

  const rows = (sessions.data ?? []).slice().sort((a, b) => (a.token === currentToken ? -1 : b.token === currentToken ? 1 : 0));

  return (
    <Section title="Active sessions" description="Devices where you're signed in.">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {rows.length === 0 && <p className="px-4 py-6 text-[13px] text-muted">No other sessions.</p>}
        {rows.map((s) => {
          const isCurrent = s.token === currentToken;
          return (
            <div
              key={s.token}
              className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {describeAgent(s.userAgent)}
                  {isCurrent && <span className="ml-2 text-[12px] text-success">This device</span>}
                </p>
                <p className="text-[12px] text-muted">
                  {s.ipAddress || 'unknown IP'} · signed in {fmt.dateTime(s.createdAt)}
                </p>
              </div>
              {!isCurrent && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.token)}>
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
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
