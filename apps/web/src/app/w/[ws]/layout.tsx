'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useSession } from '@/lib/auth-client';
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
          <span className="text-sm text-muted">{session.user.name}</span>
          <Link href="/" className="text-[13px] text-muted hover:text-ink">
            Switch workspace
          </Link>
        </header>
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
