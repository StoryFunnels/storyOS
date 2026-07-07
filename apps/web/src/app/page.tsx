'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';

/** Entry: route to the user's workspace, workspace creation, or login. */
export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => (await api.GET('/api/v1/workspaces')).data as Array<{ id: string }>,
    enabled: Boolean(session),
  });

  useEffect(() => {
    if (isPending) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    if (workspaces.data) {
      router.replace(workspaces.data.length > 0 ? `/w/${workspaces.data[0]!.id}` : '/new-workspace');
    }
  }, [isPending, session, workspaces.data, router]);

  return (
    <main className="flex min-h-screen items-center justify-center text-muted">Loading StoryOS…</main>
  );
}
