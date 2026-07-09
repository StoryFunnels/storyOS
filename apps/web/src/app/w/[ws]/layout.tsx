'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useSession } from '@/lib/auth-client';
import { AccountMenu } from '@/components/account-menu';
import { Sidebar } from '@/components/sidebar';

/** The protected workspace shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  if (isPending || !session) {
    return <main className="flex min-h-screen items-center justify-center text-muted">Loading…</main>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-default bg-card px-4">
          <AccountMenu />
        </header>
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
