'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Toaster } from 'sonner';
import { useSession } from '@/lib/auth-client';
import { AccountMenu } from '@/components/account-menu';
import { CommandPalette } from '@/components/command-palette';
import { QuickAddFab } from '@/components/quick-add-fab';
import { ShortcutsOverlay } from '@/components/shortcuts-overlay';
import { Sidebar } from '@/components/sidebar';
import { useSidebarCollapsed } from '@/lib/sidebar-state';
import { cn } from '@/lib/utils';

/** The protected workspace shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();

  // Off-canvas drawer under md (MN-230b). Plain useState(false) — never read
  // from storage — so the drawer is guaranteed CLOSED on first paint and a
  // record is readable without the user manually closing it.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Persistent, per-user collapse toggle for md+ (MN-230b new requirement).
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  // Navigating (tapping a sidebar link) closes the mobile drawer so the
  // destination is immediately visible instead of hidden behind it.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (isPending || !session) {
    return <main className="flex min-h-screen items-center justify-center text-muted">Loading…</main>;
  }

  return (
    // h-screen (not min-h-screen): main must be the scroll container, or every
    // view's h-full/overflow-auto and sticky header attach to a scroller that
    // never scrolls and the chrome scrolls away with the document (MN-117).
    <div className="flex h-screen overflow-hidden">
      {/* Mobile-only backdrop — tapping it closes the drawer, same as the X. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-[rgba(15,23,41,0.35)] md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={cn(
          'z-40 h-full shrink-0 transition-transform duration-200 ease-out',
          'fixed inset-y-0 left-0 md:static md:z-auto md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop collapse (persistent, per-user): fully removed from the
          // md+ flow rather than animated to width 0, keeping this simple and
          // avoiding an in-between state where a 0-width scroll area exists.
          collapsed && 'md:hidden',
        )}
      >
        <Sidebar onCloseMobile={() => setMobileOpen(false)} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-default bg-card px-4">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              title="Open sidebar"
              className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink md:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={toggleCollapsed}
              title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
              className="hidden rounded p-1.5 text-muted hover:bg-hover hover:text-ink md:flex"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
          <AccountMenu />
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickAddFab />
      <Toaster position="bottom-right" />
    </div>
  );
}
