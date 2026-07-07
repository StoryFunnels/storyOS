'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authClient, useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { AuthCard } from '../auth-card';
import { Button } from '@/components/ui/button';
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
    else router.replace(nextUrl);
  }

  return (
    <AuthCard title="Sign in to StoryOS">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-[13px] text-error">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {providers.data?.providers.includes('google') && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: '/' })}
          >
            Continue with Google
          </Button>
        )}
      </form>
      <p className="mt-4 text-[13px] text-muted">
        No account?{' '}
        <Link className="text-ink underline" href="/signup">
          Sign up
        </Link>
        {' · '}
        <Link className="text-ink underline" href="/reset">
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
