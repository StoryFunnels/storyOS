'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authClient, useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** The protected workspace shell: sidebar (spaces/databases in MN-015) + topbar. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const params = useParams<{ ws: string }>();
  const { data: session, isPending } = useSession();

  const workspace = useQuery({
    queryKey: ['workspace', params.ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}', {
        params: { path: { ws: params.ws } },
      });
      if (error) throw error;
      return data as { id: string; name: string; role: string };
    },
    enabled: Boolean(session),
  });

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  if (isPending || !session) {
    return <main className="flex min-h-screen items-center justify-center text-muted">Loading…</main>;
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-border-default bg-sidebar">
        <div className="flex h-12 items-center gap-2 border-b border-border-default px-4">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-bold text-[var(--text-on-dark)]">
            {workspace.data?.name?.[0]?.toUpperCase() ?? 'S'}
          </div>
          <span className="truncate text-sm font-semibold text-ink">
            {workspace.data?.name ?? '…'}
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-faint">
            Spaces
          </p>
          <p className="px-2 py-1 text-[13px] text-muted">Databases arrive with MN-015.</p>
        </nav>
        <div className="border-t border-border-default p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={async () => {
              await authClient.signOut();
              router.replace('/login');
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b border-border-default bg-card px-4">
          <span className="text-sm text-muted">{session.user.name}</span>
          <Link href="/" className="text-[13px] text-muted hover:text-ink">
            Switch workspace
          </Link>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
