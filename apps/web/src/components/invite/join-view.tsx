'use client';

import Link from 'next/link';
import type { FormEvent, ReactNode } from 'react';
import { AuthCard } from '@/app/(auth)/auth-card';
import { Avatar } from '@/components/ui/avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Quill } from '@/components/quill/quill';
import { cn } from '@/lib/utils';
import type { JoinModel } from '@/lib/invite-screen';

/**
 * Ticket #1302 — the Join screen, drawn from a `JoinModel`. Pure of data fetching and auth so every state renders in a test; the page
 * owns the state and hands this the callbacks. Everything on it comes from the shared kit: AuthCard, Avatar, Button (the one size),
 * Input, Label, and the Quill notice shape the 404 uses. The token is never an input here, so it cannot be drawn.
 */
export function WorkspaceMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <div className="mb-5 flex items-center gap-3" data-testid="invite-workspace">
      <Avatar userId={name} name={name} image={logoUrl} size={64} />
      <span className="text-prose font-semibold text-ink">{name}</span>
    </div>
  );
}

export function LockedEmail({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="invited-email">Email</Label>
      <Input id="invited-email" type="email" readOnly value={email} aria-describedby="invited-email-hint" className="h-11 bg-hover" />
      <p id="invited-email-hint" className="m-0 text-label text-muted">
        The invite was sent to this address, so it cannot be changed.
      </p>
    </div>
  );
}

export interface SignedOutFormProps {
  action: string;
  invitedEmail: string;
  /** `new` asks for a name and a new password; `existing` asks only for the password of the account that already exists. */
  mode: 'new' | 'existing';
  name: string;
  password: string;
  onName: (v: string) => void;
  onPassword: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  busy: boolean;
  error: string | null;
  forgotHref: string;
  google?: ReactNode;
}

export function SignedOutForm(p: SignedOutFormProps) {
  return (
    <form onSubmit={p.onSubmit} className="flex flex-col gap-4">
      <LockedEmail email={p.invitedEmail} />
      {p.mode === 'existing' ? (
        <p className="m-0 text-body text-ink-secondary" role="status">
          You already have a StoryOS account with this email. Enter its password to continue.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="join-name">Your name</Label>
          <Input id="join-name" required autoComplete="name" className="h-11" value={p.name} onChange={(e) => p.onName(e.target.value)} />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="join-password">{p.mode === 'existing' ? 'Password' : 'Choose a password'}</Label>
        <Input
          id="join-password"
          type="password"
          required
          minLength={p.mode === 'existing' ? undefined : 8}
          autoComplete={p.mode === 'existing' ? 'current-password' : 'new-password'}
          className="h-11"
          value={p.password}
          onChange={(e) => p.onPassword(e.target.value)}
        />
      </div>
      {p.error && (
        <p className="m-0 text-body text-error" role="alert">
          {p.error}
        </p>
      )}
      <Button type="submit" disabled={p.busy}>
        {p.busy ? 'Joining…' : p.action}
      </Button>
      {p.google}
      {p.mode === 'existing' && (
        <p className="m-0 text-body text-muted">
          <Link className="inline-block px-1 py-3 text-ink underline" href={p.forgotHref}>
            Forgot password
          </Link>
        </p>
      )}
    </form>
  );
}

export interface JoinViewProps {
  model: JoinModel;
  signedIn: boolean;
  /** Drawn for `join_signed_out`. */
  signedOutForm?: ReactNode;
  onJoin?: () => void;
  onSwitchAccount?: () => void;
  busy?: boolean;
  /** A sentence under the one-click button after a failed accept. */
  error?: string | null;
}

export function JoinView({ model, signedIn, signedOutForm, onJoin, onSwitchAccount, busy = false, error = null }: JoinViewProps) {
  switch (model.kind) {
    case 'loading':
      return (
        <AuthCard title="Workspace invitation">
          <p className="m-0 text-body text-muted" role="status">
            Checking your invite…
          </p>
        </AuthCard>
      );
    case 'unavailable':
      return (
        <AuthCard title={model.title}>
          <p className="m-0 text-body text-ink-secondary" role="alert">
            {model.body}
          </p>
        </AuthCard>
      );
    case 'not_found':
      // The 404's shape (Quill lost, what is true in plain words, the one way on; no shell around it), composed here rather than by
      // editing the shared 404 view, which another open change restructures. A signed-in person has a better way on than the site.
      return (
        <main className="min-h-screen bg-app" data-testid="invite-not-found">
          <div className="mx-auto flex max-w-[440px] flex-col items-center gap-2.5 px-4 pb-10 pt-[12vh] text-center" data-testid="not-found">
            <Quill pose="lost" size={120} caption="This was an invite once." captionClassName="max-w-[160px] text-[16px]" />
            <h1 className="m-0 mt-1.5 text-title font-bold leading-[1.25] text-ink">{model.title}</h1>
            <p className="m-0 text-body text-muted">{model.body}</p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-3.5">
              <Link href={signedIn ? '/' : 'https://storyos.dev'} className={cn(buttonVariants({ variant: 'primary' }))}>
                {signedIn ? 'Go to my workspaces' : 'Go to storyos.dev'}
              </Link>
            </div>
          </div>
        </main>
      );
    case 'expired':
    case 'used':
      return (
        <AuthCard title={model.title}>
          <WorkspaceMark name={model.workspaceName} logoUrl={model.logoUrl} />
          <p className="m-0 mb-5 text-body text-ink-secondary">{model.body}</p>
          <Link href={signedIn ? '/' : '/login'} className={cn(buttonVariants({ variant: 'secondary' }))}>
            {signedIn ? 'Go to my workspaces' : 'Sign in'}
          </Link>
        </AuthCard>
      );
    case 'join_signed_out':
      return (
        <AuthCard title={model.title}>
          <WorkspaceMark name={model.workspaceName} logoUrl={model.logoUrl} />
          {signedOutForm}
        </AuthCard>
      );
    case 'join_one_click':
      return (
        <AuthCard title={model.title}>
          <WorkspaceMark name={model.workspaceName} logoUrl={model.logoUrl} />
          <div className="flex flex-col gap-4">
            <LockedEmail email={model.invitedEmail} />
            {error && (
              <p className="m-0 text-body text-error" role="alert">
                {error}
              </p>
            )}
            <Button type="button" disabled={busy} onClick={onJoin}>
              {busy ? 'Joining…' : model.action}
            </Button>
          </div>
        </AuthCard>
      );
    case 'mismatch':
      return (
        <AuthCard title={model.title}>
          <WorkspaceMark name={model.workspaceName} logoUrl={model.logoUrl} />
          <p className="m-0 mb-5 text-body text-ink-secondary" role="alert">
            {model.body}
          </p>
          <Button type="button" onClick={onSwitchAccount} disabled={busy}>
            {model.switchLabel}
          </Button>
        </AuthCard>
      );
  }
}
