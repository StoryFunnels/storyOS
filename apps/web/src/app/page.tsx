'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { sessionVerdict } from '@/lib/session-state';
import { heldInviteToken, postSignInDestination } from '@/lib/invite-join';
import { returnPathFromSearch } from '@/lib/return-to';
import { SessionUnavailable } from '@/components/session-unavailable';

/** Entry: route to the user's workspace, workspace creation, or login. */
export default function Home() {
  const router = useRouter();
  const { data: session, isPending, error: sessionError, refetch } = useSession();
  // #1394 — a Google round trip lands here carrying the link the person was sent. Read once at mount, before the funnel beacon rewrites the URL.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    returnTo.current = returnPathFromSearch(window.location.search);
  }, []);
  const verdict = sessionVerdict({ data: session, isPending, error: sessionError });

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces');
      if (error) throw error;
      return data as Array<{ id: string }>;
    },
    enabled: Boolean(session),
  });

  useEffect(() => {
    // #948 — only an answer of "no session" is a sign-out; an unreachable API is not.
    if (verdict === 'pending' || verdict === 'unavailable') return;
    if (verdict === 'signed_out') {
      router.replace('/login');
      return;
    }
    if (verdict === 'authed' && returnTo.current) {
      router.replace(returnTo.current);
      return;
    }
    if (workspaces.data) {
      // #1302 — a held invite wins over "no workspace yet": that is where a new invited account used to be sent to create its own.
      router.replace(postSignInDestination({ workspaceIds: workspaces.data.map((w) => w.id), held: heldInviteToken(window.sessionStorage, Date.now()) }));
    }
  }, [verdict, workspaces.data, router]);

  if (verdict === 'unavailable') {
    return (
      <main className="flex min-h-screen">
        <SessionUnavailable retry={() => void refetch()} />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center text-muted">Loading StoryOS…</main>
  );
}
