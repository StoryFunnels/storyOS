'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { useSession } from '@/lib/auth-client';
import { AuthCard } from '../(auth)/auth-card';
import { Button } from '@/components/ui/button';

function InviteAccept() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const { data: session, isPending } = useSession();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (isPending || !session || !token || attempted.current) return;
    attempted.current = true;
    void (async () => {
      const { data, error: apiError } = await api.POST('/api/v1/invites/accept', {
        body: { token },
      });
      if (apiError) {
        setError(isErrorEnvelope(apiError) ? apiError.error.message : 'Could not accept the invite');
        return;
      }
      router.replace(`/w/${(data as { workspace_id: string }).workspace_id}`);
    })();
  }, [isPending, session, token, router]);

  if (!token) return <p className="text-sm text-error">This invite link is missing its token.</p>;

  if (!isPending && !session) {
    const next = encodeURIComponent(`/invite?token=${token}`);
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-secondary">
          Sign in or create an account with the invited email address to join this workspace.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => router.push(`/signup?next=${next}`)}>Create account</Button>
          <Button variant="secondary" onClick={() => router.push(`/login?next=${next}`)}>
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-error">{error}</p>
        <Link href="/" className="text-[13px] text-ink underline">
          Go to my workspaces
        </Link>
      </div>
    );
  }

  return <p className="text-sm text-muted">Joining the workspace…</p>;
}

export default function InvitePage() {
  return (
    <AuthCard title="Workspace invitation">
      <Suspense>
        <InviteAccept />
      </Suspense>
    </AuthCard>
  );
}
