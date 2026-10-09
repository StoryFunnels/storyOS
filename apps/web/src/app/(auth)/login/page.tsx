'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { useQuery } from '@tanstack/react-query';
import { authClient, useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { AuthCard } from '../auth-card';
import { Button } from '@/components/ui/button';
import { GoogleIcon } from '@/components/ui/google-icon';
import { GOOGLE_NEW_USER_CALLBACK, GOOGLE_RETURNING_CALLBACK } from '@/lib/funnel';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function LoginForm() {
  const router = useRouter();
  const nextUrl = useSearchParams().get('next') ?? '/';
  const { data: session } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () =>
      (await api.GET('/api/v1/auth/providers')).data as { providers: string[] },
  });

  useEffect(() => {
    if (session) router.replace(nextUrl);
  }, [session, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) setError(result.error.message ?? 'Sign-in failed');
    else {
      posthog.capture('user_logged_in', { method: 'email' });
      router.replace(nextUrl);
    }
  }

  return (
    <AuthCard title="Sign in to StoryOS">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
            className="h-11"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-body text-error">{error}</p>}
        <Button type="submit" disabled={busy} className="h-11">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {providers.data?.providers.includes('google') && (
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            onClick={() => {
              // #818 — NOT captured here: a click is not a login (the visitor can abandon
              // the consent screen). The event fires on the redirect back, in AuthEventBeacon,
              // as user_logged_in for a returning account and user_signed_up for a new one.
              authClient.signIn.social({
                provider: 'google',
                callbackURL: GOOGLE_RETURNING_CALLBACK,
                newUserCallbackURL: GOOGLE_NEW_USER_CALLBACK,
              });
            }}
          >
            <GoogleIcon className="h-[18px] w-[18px]" />
            Continue with Google
          </Button>
        )}
      </form>
      {/* #707 — same tap-target fix as signup's "Sign in" link; py-3 pads each
          toward the 44px guideline without redesigning this line. */}
      <p className="mt-4 text-body text-muted">
        No account?{' '}
        <Link className="inline-block px-1 py-3 text-ink underline" href="/signup">
          Sign up
        </Link>
        {' · '}
        <Link className="inline-block px-1 py-3 text-ink underline" href="/reset">
          Forgot password
        </Link>
      </p>
    </AuthCard>
  );
}


export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
