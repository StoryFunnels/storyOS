'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { sessionVerdict } from '@/lib/session-state';
import { SessionUnavailable } from '@/components/session-unavailable';

/** Entry: route to the user's workspace, workspace creation, or login. */
export default function Home() {
  const router = useRouter();
  const { data: session, isPending, error: sessionError, refetch } = useSession();
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
    if (workspaces.data) {
      router.replace(workspaces.data.length > 0 ? `/w/${workspaces.data[0]!.id}` : '/new-workspace');
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
