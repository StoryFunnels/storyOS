'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/safe-next';
import { withReturnPath } from '@/lib/return-to';
import { inviteJoinPath, inviteTokenFromNext } from '@/lib/invite-join';
import { Suspense, useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { authClient } from '@/lib/auth-client';
import { attributeCapturedReferral } from '@/lib/referral';
import {
  GOOGLE_NEW_USER_CALLBACK,
  GOOGLE_RETURNING_CALLBACK,
  firstTouchProperties,
  readFirstTouch,
} from '@/lib/funnel';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AuthCard, AuthMethods } from '../auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function SignupForm() {
  const router = useRouter();
  const rawNext = useSearchParams().get('next');
  const nextUrl = safeNextPath(rawNext); // #1052: same-site paths only
  // Ticket #1302 — an invite never sees this generic form: the Join screen creates the account inline and joins in one action.
  const inviteToken = inviteTokenFromNext(rawNext);
  useEffect(() => {
    if (inviteToken) router.replace(inviteJoinPath(inviteToken));
  }, [inviteToken, router]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () => (await api.GET('/api/v1/auth/providers')).data as { providers: string[] },
  });
  // Ticket #1302 — sign-up offers Google first too (same flow as sign-in: the account is created on the way back).
  const onGoogle = () => {
    void authClient.signIn.social({
      provider: 'google',
      callbackURL: withReturnPath(GOOGLE_RETURNING_CALLBACK, nextUrl), // #1394
      newUserCallbackURL: withReturnPath(GOOGLE_NEW_USER_CALLBACK, nextUrl),
    });
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signUp.email({ email, password, name });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? 'Sign-up failed');
      return;
    }
    posthog.capture('user_signed_up', {
      method: 'email',
      ...firstTouchProperties(readFirstTouch(window.sessionStorage)),
    });
    // #33 — best-effort, never blocks the redirect: an unattributed sign-up
    // is a missed reward, not a broken account.
    await attributeCapturedReferral();
    router.replace(nextUrl);
  }

  return (
    <AuthCard title="Create your account">
      <AuthMethods onGoogle={providers.data?.providers.includes('google') ? onGoogle : null}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              required
              className="h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              className="h-11"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              className="h-11"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-body text-error">{error}</p>}
          <Button type="submit" size="auth" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      </AuthMethods>
      <p className="mt-4 text-body text-muted">
        Already have an account?{' '}
        {/* #707 — a plain inline link's tap target is just its text's line box
            (measured at 16px tall). py-3 pads it toward the 44px guideline;
            the paragraph grows to fit rather than needing a negative-margin
            trick, since a slightly taller line here isn't a redesign. */}
        <Link className="inline-block px-1 py-3 text-ink underline" href="/login">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
