'use client';

import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { StoryOSToaster } from '@/components/ui/toaster';
import { UndoHotkey } from '@/components/undo-hotkey';
import { useSession } from '@/lib/auth-client';
import { AccountMenu } from '@/components/account-menu';
import { CommandPalette } from '@/components/command-palette';
import { QuickAddFab } from '@/components/quick-add-fab';
import { ShortcutsOverlay } from '@/components/shortcuts-overlay';
import { Sidebar } from '@/components/sidebar';
import { SplitArea, SplitHost } from '@/components/entity/split-screen-host';
import { useSidebarCollapsed } from '@/lib/sidebar-state';
import { TyronPanel } from '@/components/tyron/tyron-panel';
import { useTyronPanel } from '@/lib/tyron-panel';
import { cn } from '@/lib/utils';

/** The protected workspace shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();

  // Off-canvas drawer under md (MN-230b). Plain useState(false) — never read
  // from storage — so the drawer is guaranteed CLOSED on first paint and a
  // record is readable without the user manually closing it.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Persistent, per-user collapse toggle for md+ (MN-230b new requirement).
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  // #356 — FULL means the panel takes the window. Read here because <main> is the
  // thing that has to give way, and it is owned by this layout.
  const { state: tyronState } = useTyronPanel();

  /**
   * #486 — the actual root cause, found by reading useSession() itself
   * (better-auth's react-store.mjs), not just this component: it calls
   * `useSyncExternalStore(subscribe, get, get)` — the SAME getter for the
   * client snapshot and the server snapshot. `getServerSnapshot` exists so a
   * hook can hand back a value that is STABLE for the whole hydration pass,
   * matching whatever the server actually rendered; passing `get` for both
   * throws that guarantee away; React calls it again on the client during
   * hydration, and by then the store may already hold the resolved session
   * (nanostores can settle before this component's ref initializer runs), so
   * the "server snapshot" React hydrates against on the client is not
   * actually what the server sent. That timing is exactly why this reproduced
   * on /d/{db} and not /w/{ws} before this fix: a heavier page gives the
   * async session check more wall-clock time to resolve before hydration
   * reaches this component, not a difference in what either route renders.
   *
   * This is third-party code (node_modules), not ours to patch. The house-
   * side fix is the standard one for exactly this class of bug: never trust
   * session state before the component has mounted at least once. `mounted`
   * starts false on both server and client — genuinely identical, no store
   * involved — and flips true only inside an effect, which never runs during
   * SSR and never runs during hydration itself (effects fire strictly after
   * the commit). So the FIRST client render is forced to agree with the
   * server regardless of how fast useSession's store resolves; the swap to
   * real content happens on the render *after* that, which is an ordinary
   * post-hydration update, not a hydration diff, and warns about nothing.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (mounted && !isPending && !session) router.replace('/login');
  }, [mounted, isPending, session, router]);

  // Navigating (tapping a sidebar link) closes the mobile drawer so the
  // destination is immediately visible instead of hidden behind it.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const authed = mounted && !isPending && !!session;

  return (
    /*
     * #462 — SplitHost wraps the WHOLE layout, not just <main>. It renders no
     * markup; it publishes the split context. Everything that can open a record
     * beside the current one has to be inside it, and the command palette is
     * mounted near the bottom of this tree as a sibling of the main column — so
     * wrapping only <main> left the palette outside and a search result kept
     * navigating, which is the bug this ticket exists to fix. `SplitArea` below
     * draws the actual panes, in the row where they belong.
     */
    <SplitHost ws={ws}>
    {/* h-screen (not min-h-screen): main must be the scroll container, or every
        view's h-full/overflow-auto and sticky header attach to a scroller that
        never scrolls and the chrome scrolls away with the document (MN-117). */}
    <div className="flex h-screen overflow-hidden">
      {!authed ? (
        // #486 — same element type (`<div>`, inside the same unconditional
        // shell) on both passes; only its own children differ, which is not a
        // structural mismatch. An unauthenticated visitor still sees this and
        // is still redirected by the effect above; an authed one sees it for
        // one frame at most, same as before.
        <div className="flex flex-1 items-center justify-center text-muted">Loading…</div>
      ) : (
        <>
      {/* Mobile-only backdrop — tapping it closes the drawer, same as the X. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[var(--z-drawer-backdrop)] bg-[rgba(15,23,41,0.35)] md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={cn(
          'z-[var(--z-drawer)] h-full shrink-0 transition-transform duration-200 ease-out',
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
        {/* #356 — the main content and Tyron are a PAIR, so the panel is a sibling
            of <main> inside this column rather than an overlay. An overlay would
            cover the table, and seeing rows change while Tyron works is the entire
            argument for docking it instead of floating it. */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/*
            #462 — the split host lives HERE, not inside each page.
            The host has to be an ANCESTOR of everything that can open a record
            beside the current one, because `useOpenRecord` reads it from React
            context. #199 mounted it per page, which covered every in-page surface
            but left out the one thing that is not in a page: the command palette,
            rendered below as a sibling of <main>. A search result therefore had no
            context to find and fell back to navigating — the behaviour #462 exists
            to fix. Wrapping <main> puts the palette inside the host without moving
            the palette itself.

            The primary pane is whatever page is mounted; it tells the host what to
            call its rail through `RecordSurface` / `ListSurface`. A page that uses
            neither still works — it simply never registers a label and never draws
            pane controls, and the split opens beside it with a default spine.
          */}
          <SplitArea
            renderPrimary={() => (
              <main
                className={cn(
                  'min-h-0 min-w-0 flex-1 overflow-auto',
                  // Hidden, not unmounted: unmounting would tear down the table's
                  // scroll position and any in-flight edit, so leaving full would not
                  // return you to where you were. #356 requires the built workspace to
                  // be "already in place" when full is left.
                  tyronState === 'full' && 'hidden',
                )}
              >
                {children}
              </main>
            )}
          />
          <TyronPanel />
        </div>
      </div>
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickAddFab />
      <UndoHotkey />
      <StoryOSToaster />
        </>
      )}
    </div>
    </SplitHost>
  );
}
