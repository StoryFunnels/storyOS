'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useSession } from '@/lib/auth-client';
import { AccountMenu } from '@/components/account-menu';
import { CommandPalette } from '@/components/command-palette';
import { ShortcutsOverlay } from '@/components/shortcuts-overlay';
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
    // h-screen (not min-h-screen): main must be the scroll container, or every
    // view's h-full/overflow-auto and sticky header attach to a scroller that
    // never scrolls and the chrome scrolls away with the document (MN-117).
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-default bg-card px-4">
          <AccountMenu />
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <CommandPalette />
      <ShortcutsOverlay />
      <Toaster position="bottom-right" />
    </div>
  );
}
