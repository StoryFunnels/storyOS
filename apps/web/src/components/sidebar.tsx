'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { computeReorder } from '@/lib/reorder';
import { Activity, Cable, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Database, Eye, EyeOff, FileText, Folder as FolderIcon, LayoutDashboard, GitPullRequest, GripVertical, Home, Inbox, Keyboard, KeyRound, LayoutTemplate, MoreHorizontal, Package, Plug, Plus, Search, Settings, Star, UserRound, Webhook, X, Sparkles} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DragPreview, DropIndicator, useDragPresentation, vacatedSlotClass } from '@/components/ui/drag-presentation';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { AutomationsPanel } from '@/components/automations-panel';
import { ImportWizard } from '@/components/import-wizard';
import { SourcesDialog } from '@/components/sources-dialog';
import { InboxPanel, useUnreadCount } from '@/components/inbox-panel';
import { openPalette, openShortcuts, useShortcutKeys } from '@/lib/shortcuts';
import { useDatabases, useSidebarMutations, useSpaces, useWorkspace } from '@/lib/queries';
import { useHidden } from '@/lib/hidden-sidebar';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { ShareDialog } from '@/components/share-dialog';
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { TemplateGalleryDialog } from '@/components/template-gallery';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { DescriptionDialogContent } from '@/components/description-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useSignOut } from '@/lib/sign-out';
import { cn } from '@/lib/utils';
import { SIDEBAR_INDENT_PX, SidebarRow, type SidebarDepth } from '@/components/sidebar-row';
import { SidebarViewRow, type SidebarView } from '@/components/sidebar-view-row';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';
import { openTyron } from '@/lib/tyron-panel';

interface Favorite {
  target_type: 'record' | 'database';
  target_id: string;
  title: string;
  database_id?: string;
  icon?: string | null;
}

/** Per-user favorites query, shared by the sidebar section and the star toggle (MN-075). */
export function useFavorites(ws: string) {
  return useQuery({
    queryKey: ['favorites', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/favorites', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as Favorite[];
    },
  });
}

/** Favorites section at the top of the sidebar. Hidden when the user has none. */
function FavoritesSection({ ws }: { ws: string }) {
  const favorites = useFavorites(ws);
  const items = favorites.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Favorites</div>
      <div className="flex flex-col gap-0.5">
        {items.map((f) => (
          <Link
            key={`${f.target_type}:${f.target_id}`}
            href={f.target_type === 'record' ? `/w/${ws}/d/${f.database_id}/r/${f.target_id}` : `/w/${ws}/d/${f.target_id}`}
            className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
          >
            <Star className="h-3.5 w-3.5 shrink-0 fill-[var(--accent)] text-[var(--accent)]" />
            <span className="truncate">{f.title}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Sidebar({ onCloseMobile }: { onCloseMobile?: () => void } = {}) {
  const params = useParams<{ ws: string }>();
  const ws = params.ws;
  const signOut = useSignOut();
  const workspace = useWorkspace(ws);
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const mutations = useSidebarMutations(ws);

  const canEdit = workspace.data?.role !== 'guest';
  const isAdmin = workspace.data?.role === 'admin';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  // #396 — platform-correct display keys; see the comment at the Search row.
  const paletteKeys = useShortcutKeys('palette');
  const unread = useUnreadCount(ws);
  const { isHidden, unhide } = useHidden(ws);

  // Personal hide (#35): hidden spaces drop out entirely; a database hidden on its own
  // (its space still visible) drops out too. Both surface in the Hidden section.
  const allSpaces = spaces.data ?? [];
  const allDatabases = databases.data ?? [];
  const visibleSpaces = allSpaces.filter((s) => !isHidden('space', s.id));
  const hiddenSpaces = allSpaces.filter((s) => isHidden('space', s.id));
  const hiddenDatabases = allDatabases.filter((d) => isHidden('database', d.id) && !isHidden('space', d.spaceId));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onSpaceDragEnd(event: DragEndEvent) {
    if (!event.over) return;
    // Reorder over the full space list (positions are shared), so dragging a
    // space across several slots shifts the run instead of swapping endpoints.
    for (const move of computeReorder(spaces.data ?? [], String(event.active.id), String(event.over.id))) {
      mutations.updateSpace.mutate(move);
    }
  }

  /*
   * #409/#412/#415 — one hook supplies the overlay tracking and the spoken
   * announcements. `label` maps a sortable id to a NAME, which is the whole fix
   * for #415: every sortable in this app is keyed by uuid, so dnd-kit's stock
   * strings read out hex ("Picked up draggable item 102568ca-…").
   */
  const spaceDrag = useDragPresentation(
    (id) => visibleSpaces.find((sp) => sp.id === id)?.name,
    { onDragEnd: onSpaceDragEnd },
    visibleSpaces.map((sp) => sp.id),
  );

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border-default bg-sidebar">
      <div className="flex shrink-0 items-stretch">
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher ws={ws} currentName={workspace.data?.name} />
        </div>
        {onCloseMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            title="Close sidebar"
            className="flex shrink-0 items-center border-b border-border-default px-3 text-faint hover:bg-hover hover:text-muted md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Sticky top nav — stays put while the spaces tree scrolls (issue #34). */}
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border-default px-2 py-1.5">
        <Link
          href={`/w/${ws}`}
          className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
        >
          <Home className="h-3.5 w-3.5" /> Home
        </Link>
        <button
          className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
          onClick={openPalette}
        >
          <Search className="h-3.5 w-3.5" /> Search
          {/* #254 — from the shared registry, so it can't drift from the binding.
              #396 — and rendered for THIS reader's platform: `shortcutKeys` now
              returns the raw "mod+K" token, so displaying it directly would show
              a Windows user a shortcut that does not exist. */}
          <span className="ml-auto text-[10px] text-faint">{paletteKeys}</span>
        </button>
        <button
          className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
          onClick={() => setInboxOpen(true)}
        >
          <Inbox className="h-3.5 w-3.5" /> Inbox
          {(unread.data ?? 0) > 0 && (
            <span className="ml-auto rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-semibold text-[var(--text-on-dark)]">
              {(unread.data ?? 0) > 99 ? '99+' : unread.data}
            </span>
          )}
        </button>
        <Link
          href={`/w/${ws}/me`}
          className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
        >
          <UserRound className="h-3.5 w-3.5" /> My Work
        </Link>
        <Link
          href={`/w/${ws}/reviews`}
          className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
        >
          <GitPullRequest className="h-3.5 w-3.5" /> Reviews
        </Link>
        <Link
          href={`/w/${ws}/packs`}
          className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
        >
          <Package className="h-3.5 w-3.5" /> Business Packs
        </Link>
        <Link
          href={`/w/${ws}/runs`}
          className="flex items-center gap-2 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
        >
          <Activity className="h-3.5 w-3.5" /> Runs
        </Link>
        {/* #356 — the discoverability a keyboard shortcut can never give a
            newcomer. A button, not a Link: Tyron is a panel beside the page, not
            a place to navigate to, and making it a route would imply leaving
            whatever you are looking at. */}
        <button
          type="button"
          onClick={openTyron}
          className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-left text-[13px] text-ink-secondary hover:bg-hover"
        >
          <Sparkles className="h-3.5 w-3.5" /> Ask Tyron
          <span className="ml-auto text-[11px] text-faint">⌘J</span>
        </button>
      </div>
      {inboxOpen && <InboxPanel ws={ws} onClose={() => setInboxOpen(false)} />}

      <nav className="flex-1 overflow-y-auto p-2">
        <FavoritesSection ws={ws} />
        <div className="mb-0.5 mt-1 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Spaces</span>
          {(spaces.data ?? []).length > 0 && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('storyos:collapse-all'))}
              title="Collapse all spaces"
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-muted"
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* #409/#412/#415 — the shared drag presentation: a portalled preview so
            the dragged row cannot paint over its neighbours, and announcements
            that name the space instead of reading out its uuid. */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          {...spaceDrag.contextProps}
        >
          <SortableContext items={visibleSpaces.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {visibleSpaces.map((space) => (
              <SpaceSection
                key={space.id}
                ws={ws}
                space={space}
                databases={allDatabases.filter((d) => d.spaceId === space.id && !isHidden('database', d.id))}
                canEdit={canEdit}
                isAdmin={isAdmin}
              />
            ))}
          </SortableContext>
          <DragPreview>
            {spaceDrag.activeId && (
              <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-[3px] text-[11px] font-semibold uppercase tracking-wider text-muted shadow-[0_8px_24px_rgba(15,23,41,0.25)]">
                {visibleSpaces.find((sp) => sp.id === spaceDrag.activeId)?.name ?? ''}
              </div>
            )}
          </DragPreview>
        </DndContext>

        {canEdit && <NewSpaceButton onCreate={(name) => mutations.createSpace.mutate({ name })} />}
        {canEdit && (
          <>
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-[13px] text-muted hover:bg-hover"
              onClick={() => setGalleryOpen(true)}
            >
              <LayoutTemplate className="h-3.5 w-3.5" /> From template
            </button>
            {galleryOpen && (
              <TemplateGalleryDialog
                ws={ws}
                spaces={spaces.data ?? []}
                open={galleryOpen}
                onOpenChange={setGalleryOpen}
              />
            )}
          </>
        )}

        <HiddenSection spaces={hiddenSpaces} databases={hiddenDatabases} onUnhide={unhide} />
      </nav>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-border-default p-2">
        {isAdmin && (
          <>
            <Link
              href={`/w/${ws}/settings/members`}
              className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
            >
              <Settings className="h-3.5 w-3.5" /> Settings & members
            </Link>
            <Link
              href={`/w/${ws}/settings/integrations`}
              className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
            >
              <Plug className="h-3.5 w-3.5" /> Integrations
            </Link>
            <Link
              href={`/w/${ws}/settings/connections`}
              className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
            >
              <Cable className="h-3.5 w-3.5" /> Connections
            </Link>
            <Link
              href={`/w/${ws}/settings/webhooks`}
              className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
            >
              <Webhook className="h-3.5 w-3.5" /> Webhooks
            </Link>
          </>
        )}
        {canEdit && (
          <Link
            href={`/w/${ws}/settings/api`}
            className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
          >
            <KeyRound className="h-3.5 w-3.5" /> API tokens
          </Link>
        )}
        {/*
          #396 — the persistent way in.

          Of the options the ticket lists this is the highest ratio of discovery
          to effort: always visible, costs one row, and sits where people already
          look for meta controls. Explicitly NOT a one-time tour or a
          coach-mark — those fire once, at the moment a new user has the least
          room to absorb anything, and get dismissed.
        */}
        <button
          type="button"
          onClick={openShortcuts}
          className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-ink-secondary hover:bg-hover"
        >
          <Keyboard className="h-3.5 w-3.5" /> Keyboard shortcuts
          <span className="ml-auto text-[10px] text-faint">?</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </div>
    </aside>
  );
}

/** Workspace name is the switcher — lists every workspace plus creation (the old "Switch workspace" link only ever led back to the first one). */
function WorkspaceSwitcher({ ws, currentName }: { ws: string; currentName?: string }) {
  const router = useRouter();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces');
      if (error) throw error;
      return data as unknown as Array<{ id: string; name: string }>;
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-11 w-full items-center gap-2 border-b border-border-default px-4 text-left hover:bg-hover">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-[11px] font-bold text-[var(--text-on-dark)]">
            {currentName?.[0]?.toUpperCase() ?? 'S'}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {currentName ?? '…'}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {(workspaces.data ?? []).map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}`)}>
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            {w.id === ws && <Check className="h-3.5 w-3.5 shrink-0 text-muted" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => router.push('/new-workspace')}>
          <Plus className="h-3.5 w-3.5" /> New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The "Hidden" section at the bottom of the tree (#35): personally-hidden spaces and
 * databases, each with a one-click "show again". Renders nothing when empty. */
function HiddenSection({
  spaces,
  databases,
  onUnhide,
}: {
  spaces: Space[];
  databases: DatabaseSummary[];
  onUnhide: (kind: 'space' | 'database', id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = spaces.length + databases.length;
  if (count === 0) return null;
  return (
    <div className="mt-2 border-t border-border-default pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        Hidden <span className="ml-0.5 font-normal normal-case text-faint">{count}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {spaces.map((s) => (
            <HiddenRow key={`s-${s.id}`} icon={s.icon} color={s.color} name={s.name} onUnhide={() => onUnhide('space', s.id)} />
          ))}
          {databases.map((d) => (
            <HiddenRow key={`d-${d.id}`} icon={d.icon} color={d.color} name={d.name} onUnhide={() => onUnhide('database', d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HiddenRow({
  icon,
  color,
  name,
  onUnhide,
}: {
  icon: string | null;
  color: string | null;
  name: string;
  onUnhide: () => void;
}) {
  return (
    <div className="group/h flex items-center justify-between rounded px-2 py-[3px] text-[13px] text-muted">
      <span className="flex min-w-0 items-center gap-2 truncate">
        <EntityIcon icon={icon} color={color} fallback={<Database className="h-3.5 w-3.5 text-faint" />} />
        <span className="truncate">{name}</span>
      </span>
      <button
        onClick={onUnhide}
        title="Show in my sidebar"
        className="rounded p-0.5 text-faint opacity-0 hover:bg-active hover:text-muted group-hover/h:opacity-100"
      >
        <Eye className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * #382 — per-database expand state, reusing the SAME localStorage shape spaces
 * and folders already use (`storyos:space-collapsed:`,
 * `storyos:folder-collapsed:`). A third mechanism here would be the same drift
 * #380 documents for indentation.
 *
 * ONE difference, and it is the point of the ticket: the DEFAULT flips. Spaces
 * and folders default to expanded; a database defaults to COLLAPSED. So the
 * stored value means "this one is open" and absence means closed — which is why
 * the key is `-expanded:` rather than `-collapsed:`. Reusing the word
 * "collapsed" with an inverted meaning would be worse than a new key: every
 * future reader would have to remember which way this one runs.
 *
 * Per-device, matching spaces and folders. The founder asked for state to
 * survive reopening app.storyos.dev, which localStorage satisfies for the same
 * browser. Following the person across devices would mean putting it on the user
 * record — a deliberate decision recorded on #382, and not what the existing
 * two do.
 */
function useDatabaseExpanded(databaseId: string, forceOpen: boolean) {
  const key = `storyos:database-expanded:${databaseId}`;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') setExpanded(window.localStorage.getItem(key) === '1');
  }, [key]);
  const toggle = () =>
    setExpanded((e) => {
      const next = !e;
      if (typeof window !== 'undefined') {
        // Absence means collapsed, so closing REMOVES the key rather than
        // writing '0'. Otherwise every database ever opened leaves a row behind
        // forever, including deleted ones (#382 asks that keys not accumulate).
        if (next) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      }
      return next;
    });
  // You should always be able to see where you are, whatever was stored.
  return { expanded: expanded || forceOpen, toggle };
}

/**
 * #369 — the space root as a drop target, so a leaf can be dragged OUT of a
 * folder (and a view out from under its database) rather than only in.
 *
 * Without an explicit target for "no folder" the only way back out was the menu,
 * which would have left drag as a one-way trip.
 */
function RootDropZone({ spaceId, children }: { spaceId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `root:${spaceId}` });
  return (
    <div ref={setNodeRef} className={cn('rounded', isOver && 'bg-hover ring-1 ring-inset ring-accent/40')}>
      {children}
    </div>
  );
}

/** The inline name/confirm prompt (MN-24), named so row components can take it. */
type DialogState =
  | { kind: 'name'; title: string; value: string; submit: (v: string) => void }
  | { kind: 'confirm'; title: string; danger?: boolean; submit: () => void };

function SpaceSection({
  ws,
  space,
  databases,
  canEdit,
  isAdmin,
}: {
  ws: string;
  space: Space;
  databases: DatabaseSummary[];
  canEdit: boolean;
  isAdmin: boolean;
}) {
  // #417 — the typed-name guard for deleting a space (see the menu item below).
  const confirmDialog = useConfirm();
  const pathname = usePathname();
  const router = useRouter();
  // #347 — which view is open, so the nested row highlights the ACTIVE view
  // rather than every view of the open database.
  const currentViewId = useSearchParams().get('view');
  const mutations = useSidebarMutations(ws);
  const { hide } = useHidden(ws);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: space.id });
  const dbSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  /**
   * #369 — collision detection that lets a CONTAINER win.
   *
   * `closestCenter` compares the centre of every droppable, and a folder or the
   * space root is a tall container whose centre is far from the pointer — so a
   * small sortable row always won and a drop never resolved to a folder. The
   * drag activated correctly and then silently did nothing, which is the worst
   * shape of broken: it looks like it worked.
   *
   * `pointerWithin` asks what is UNDER THE POINTER instead, which is what a user
   * means by "drop it there". Containers are preferred when several match, since
   * a folder necessarily overlaps the rows inside it. Falls back to
   * closestCenter so reordering past the end of a list still works.
   */
  const collisionStrategy = (args: Parameters<typeof pointerWithin>[0]) => {
    const within = pointerWithin(args);
    const container = within.find((c) => String(c.id).startsWith('folder:') || String(c.id).startsWith('root:'));
    // A row under the pointer beats the container it sits in — that is a reorder,
    // not a move — so only fall back to the container when no row matched.
    const row = within.find((c) => !String(c.id).startsWith('folder:') && !String(c.id).startsWith('root:'));
    if (row) return [row];
    if (container) return [container];
    return closestCenter(args);
  };

  /**
   * #369 — ONE drag handler for the whole space, covering every leaf type.
   *
   * Previously each list had its own DndContext, which is why dragging could only
   * ever REORDER within a container: dnd-kit cannot see across two contexts, so a
   * folder in a different one was never a drop target. Moving between containers
   * was a menu instead.
   *
   * The ticket is explicit that if drag is built it replaces the menu for ALL
   * leaf types — three types with two different ways to be moved is worse than
   * one consistent way. The MENU STAYS as the keyboard-accessible path: drag-only
   * movement is unreachable without a pointer, so it earns its place regardless.
   */

  const onSpaceDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!over) return;
    const activeData = event.active.data.current as { kind?: string } | undefined;
    const overId = String(over.id);
    const activeId = String(event.active.id);

    // A drop onto a CONTAINER — a folder, or the space root.
    const target = overId.startsWith('folder:')
      ? overId.slice(7)
      : overId === `root:${space.id}`
        ? null
        : undefined;

    if (target !== undefined) {
      switch (activeData?.kind) {
        case 'database':
          moveToFolder(activeId, target);
          return;
        case 'view':
          onMoveView(activeId, target);
          return;
        case 'document':
          moveDocToFolder.mutate({ id: activeId, folderId: target });
          return;
        default:
          return;
      }
    }

    /**
     * Dropped onto a ROW. If that row lives in a DIFFERENT container, the user
     * means "put it there" — that is how you drag something OUT of a folder,
     * since the row you aim at is usually a sibling at the destination rather
     * than empty space. Treating this as a reorder is why dragging out silently
     * did nothing: computeReorder ran against a list the item was not in.
     */
    const overData = over.data.current as { kind?: string; folderId?: string | null } | undefined;
    const fromFolder = (activeData as { folderId?: string | null } | undefined)?.folderId ?? null;
    const toFolder = overData?.folderId ?? null;

    if (activeData?.kind === 'database' && overData?.kind === 'database' && fromFolder !== toFolder) {
      moveToFolder(activeId, toFolder);
      return;
    }
    if (activeData?.kind === 'view' && overData?.kind === 'database') {
      // A view dropped beside a database goes to that database's container.
      onMoveView(activeId, toFolder);
      return;
    }
    if (activeData?.kind === 'document' && overData?.kind === 'database') {
      moveDocToFolder.mutate({ id: activeId, folderId: toFolder });
      return;
    }

    // Same container, database → an ordinary reorder.
    if (activeData?.kind === 'database') {
      const list = databases.filter((d) => (d.folderId ?? null) === fromFolder);
      for (const move of computeReorder(list, activeId, overId)) mutations.updateDatabase.mutate(move);
    }
  };

  const [renaming, setRenaming] = useState(false);
  /**
   * #211 — the New-database dialog is shared by the space's "+" and by every
   * folder's menu, so it carries the destination rather than each caller owning a
   * copy of the dialog. `null` = the space root, a string = that folder, and
   * `undefined` = closed.
   */
  const [newDbFolder, setNewDbFolder] = useState<string | null | undefined>(undefined);
  const [sharing, setSharing] = useState(false);
  const [iconing, setIconing] = useState(false);
  // #457 — its own menu item and its own dialog, NOT folded into the inline
  // Rename. Rename is a single-line input that saves on blur; bolting a second
  // field onto it is the change most likely to break its Escape-cancels /
  // blur-saves behaviour, which the ticket names as must-keep.
  const [describing, setDescribing] = useState(false);

  // Per-user, per-space collapse (MN-088) so a packed sidebar stays scannable.
  const collapseKey = `storyos:space-collapsed:${space.id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') setCollapsed(window.localStorage.getItem(collapseKey) === '1');
  }, [collapseKey]);
  // "Collapse all" (issue #34): one button collapses every space at once.
  useEffect(() => {
    const onCollapseAll = () => {
      setCollapsed(true);
      if (typeof window !== 'undefined') window.localStorage.setItem(collapseKey, '1');
    };
    window.addEventListener('storyos:collapse-all', onCollapseAll);
    return () => window.removeEventListener('storyos:collapse-all', onCollapseAll);
  }, [collapseKey]);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      if (typeof window !== 'undefined') window.localStorage.setItem(collapseKey, next ? '1' : '0');
      return next;
    });
  };

  // Standalone documents in this space (MN-095).
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ['space-docs', ws, space.id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: space.id } },
      } as never);
      if (error) throw error;
      return (data as unknown as {
        data: Array<{ id: string; title: string; icon: string | null; folder_id: string | null }>;
      }).data;
    },
  });
  /**
   * #211 — create a document, optionally straight INSIDE a folder.
   *
   * Two calls rather than one because `CreateSpaceDocDto` takes only `title` and
   * `icon`; `folder_id` is settable on the PATCH. The ticket sanctions exactly
   * this ("create then set folder_id, or accept folder_id on create") and the
   * first half keeps it in the web lane — widening the create DTO would be an API
   * change, and there is no reason to make one for a placement the PATCH already
   * expresses.
   */
  const createDoc = useMutation({
    mutationFn: async (folderId?: string | null) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: space.id } },
        body: { title: 'Untitled' } as never,
      } as never);
      if (error) throw error;
      const doc = data as unknown as { id: string };
      if (folderId) {
        const { error: moveError } = await api.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
          params: { path: { ws, doc: doc.id } },
          body: { folder_id: folderId } as never,
        } as never);
        // A document that was created but not filed is still a document. Say so
        // rather than pretending the whole thing failed and leaving an orphan the
        // person cannot see.
        if (moveError) toast.error('Created, but could not put it in the folder');
      }
      return doc;
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['space-docs', ws, space.id] });
      router.push(`/w/${ws}/doc/${d.id}`);
    },
    onError: () => toast.error('Could not create document'),
  });

  // Folders in this space (MN-096).
  const foldersQuery = useQuery({
    queryKey: ['folders', ws, space.id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/folders', {
        params: { path: { ws, space: space.id } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; name: string; icon: string | null }> }).data;
    },
  });
  const folders = foldersQuery.data ?? [];
  const createFolder = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/folders', {
        params: { path: { ws, space: space.id } },
        body: { name } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['folders', ws, space.id] }),
    onError: () => toast.error('Could not create folder'),
  });
  const moveToFolder = (dbId: string, folderId: string | null) =>
    mutations.updateDatabase.mutate({ id: dbId, folder_id: folderId });

  // #347 — views in this space, for the tree. ONE call per space: before this
  // endpoint existed, views were reachable only per database, so rendering them
  // meant a request per database.
  const viewsQuery = useQuery({
    queryKey: ['space-views', ws, space.id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/views', {
        params: { path: { ws, space: space.id } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: SidebarView[] }).data;
    },
  });
  const spaceViews = viewsQuery.data ?? [];
  const moveViewToFolder = useMutation({
    mutationFn: async (v: { id: string; databaseId: string; folderId: string | null }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db: v.databaseId, view: v.id } },
        body: { folder_id: v.folderId } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    onError: () => toast.error('Could not move view'),
  });
  /**
   * #381 — the views to render UNDER a database.
   *
   * Excludes the one the database row itself opens. Clicking a database name
   * goes to /w/{ws}/d/{db}, which opens its default view, so listing that view
   * again as a child costs a row and delivers a destination you already had. In
   * a real workspace that is a dozen wasted rows before any content.
   *
   * Keyed on `is_default` — WHICH view the database actually opens — not a name
   * match on "All records", so a database whose default has been changed still
   * hides the right one.
   *
   * Views the member cannot see never arrive here: the endpoint applies
   * notOthersPersonalView, so a personal view of someone else's is already
   * absent and cannot inflate the count or summon a caret.
   *
   * Shared with the caret decision (#382) so the two cannot disagree about
   * whether a database has children.
   */
  const childViewsOf = (databaseId: string) =>
    spaceViews.filter((v) => v.database_id === databaseId && !v.folder_id && !v.is_default);

  /** Placement is per-view; the database is only needed to address the route. */
  const moveSpaceViewToFolder = useMutation({
    mutationFn: async (v: { id: string; folderId: string | null }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/views/{view}', {
        params: { path: { ws, view: v.id } },
        body: { folder_id: v.folderId } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    onError: () => toast.error('Could not move view'),
  });

  /** #368 — file a document into a folder, the same move databases and views have. */
  const moveDocToFolder = useMutation({
    mutationFn: async (v: { id: string; folderId: string | null }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc: v.id } },
        body: { folder_id: v.folderId } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-docs', ws, space.id] }),
    onError: () => toast.error('Could not move document'),
  });

  // #306 — a dashboard that lives in the SPACE, owning no database.
  const createSpaceDashboard = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/views', {
        params: { path: { ws, space: space.id } },
        body: { name: 'Dashboard', type: 'dashboard' } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] });
      router.push(`/w/${ws}/v/${v.id}`);
    },
    onError: () => toast.error('Could not create dashboard'),
  });

  /**
   * #383 — rename and delete a view from the sidebar.
   *
   * Both route the way `onMoveView` already does: a database-owned view through
   * its database, a space-level one through the view-first endpoint. That split
   * is not cosmetic — the per-database DELETE matches on `database_id`, so it
   * can never reach a space-level view (its `database_id` is NULL), which is why
   * a space-root dashboard was undeletable by any route before this.
   */
  const renameViewOnDatabase = useMutation({
    mutationFn: async (v: { id: string; databaseId: string; name: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db: v.databaseId, view: v.id } },
        body: { name: v.name } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    onError: () => toast.error('Could not rename view'),
  });
  const renameSpaceView = useMutation({
    mutationFn: async (v: { id: string; name: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/views/{view}', {
        params: { path: { ws, view: v.id } },
        body: { name: v.name } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    onError: () => toast.error('Could not rename view'),
  });
  const deleteViewOnDatabase = useMutation({
    mutationFn: async (v: { id: string; databaseId: string }) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db: v.databaseId, view: v.id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    // The API refuses to remove a database's LAST view (409). Say that, rather
    // than a generic failure for a rule the user could not have known.
    onError: () => toast.error('Could not delete view — a database must keep at least one.'),
  });
  const deleteSpaceView = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/views/{view}', {
        params: { path: { ws, view: id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] }),
    onError: () => toast.error('Could not delete dashboard'),
  });

  const onRenameView = (view: SidebarView) =>
    setDialog({
      kind: 'name',
      title: 'Rename view',
      value: view.name,
      submit: (name) =>
        view.database_id
          ? renameViewOnDatabase.mutate({ id: view.id, databaseId: view.database_id, name })
          : renameSpaceView.mutate({ id: view.id, name }),
    });

  const onDeleteView = (view: SidebarView) =>
    setDialog({
      kind: 'confirm',
      danger: true,
      /**
       * #383 — a dashboard's tiles and charts are configuration someone built,
       * not a derived view of a table, so the confirmation names what is lost
       * rather than asking a generic "are you sure".
       */
      title:
        view.type === 'dashboard'
          ? `Delete "${view.name}"? Its tiles and charts go with it. The records they measured are not touched.`
          : `Delete the view "${view.name}"? The records it shows are not deleted.`,
      submit: () => {
        if (view.database_id) {
          deleteViewOnDatabase.mutate({ id: view.id, databaseId: view.database_id });
          return;
        }
        deleteSpaceView.mutate(view.id);
        // A space-level view has its own route; if it is the one on screen,
        // leaving the user on a 404 would be a worse ending than the delete.
        if (pathname === `/w/${ws}/v/${view.id}`) router.push(`/w/${ws}`);
      },
    });

  /** #383 — the folder endpoints existed since MN-096 and nothing ever called them. */
  const renameFolder = useMutation({
    mutationFn: async (v: { id: string; name: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/folders/{folder}', {
        params: { path: { ws, folder: v.id } },
        body: { name: v.name } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['folders', ws, space.id] }),
    onError: () => toast.error('Could not rename folder'),
  });
  const deleteFolder = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/folders/{folder}', {
        params: { path: { ws, folder: id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      // Everything that was inside just moved to the space root — those lists
      // are now wrong too, not only the folder list.
      void qc.invalidateQueries({ queryKey: ['folders', ws, space.id] });
      void qc.invalidateQueries({ queryKey: ['space-views', ws, space.id] });
      void qc.invalidateQueries({ queryKey: ['space-docs', ws, space.id] });
      void qc.invalidateQueries({ queryKey: ['databases', ws] });
    },
    onError: () => toast.error('Could not delete folder'),
  });
  /**
   * #211 — a folder's icon. `UpdateFolderDto` has carried `icon` since MN-096 and,
   * like rename and delete before #383, nothing ever called it. Same endpoint as
   * rename, so it invalidates the same list.
   */
  const setFolderIcon = useMutation({
    mutationFn: async (v: { id: string; icon: string | null }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/folders/{folder}', {
        params: { path: { ws, folder: v.id } },
        body: { icon: v.icon } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['folders', ws, space.id] }),
    onError: () => toast.error('Could not change the folder icon'),
  });
  const onRenameFolder = (id: string, name: string) => renameFolder.mutate({ id, name });
  const onDeleteFolder = (id: string) => deleteFolder.mutate(id);
  const onFolderIcon = (id: string, icon: string | null) => setFolderIcon.mutate({ id, icon });

  const onMoveView = (viewId: string, folderId: string | null) => {
    const view = spaceViews.find((v) => v.id === viewId);
    if (!view) return;
    // #306 — a space-level view has no database to route the PATCH through, so
    // it uses the view-first endpoint. Both end in the same folder_id write.
    if (!view.database_id) {
      moveSpaceViewToFolder.mutate({ id: viewId, folderId });
      return;
    }
    moveViewToFolder.mutate({ id: viewId, databaseId: view.database_id, folderId });
  };

  // Document rename/delete (MN-26): the API already supports PATCH/DELETE; expose it.
  const renameDoc = useMutation({
    mutationFn: async (v: { id: string; title: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc: v.id } },
        body: { title: v.title } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-docs', ws, space.id] }),
    onError: () => toast.error('Could not rename document'),
  });
  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc: id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-docs', ws, space.id] }),
    onError: () => toast.error('Could not delete document'),
  });

  // Styled name/confirm dialog replaces window.prompt/confirm (MN-24).
  const [dialog, setDialog] = useState<DialogState | null>(null);


  /*
   * #409/#412/#415 — the same shared presentation for the items INSIDE a space.
   * This is the list the UAT measured: the dragged row translated by the pointer
   * delta (-60px) while its neighbours moved by one row pitch (+26px), so rows
   * visibly piled on each other. The dragged content now lives in a portalled
   * overlay and this list only shows the vacated slot.
   */
  const itemLabel = (id: string) =>
    databases.find((d) => d.id === id)?.name ??
    spaceViews.find((v) => v.id === id)?.name ??
    (docs.data ?? []).find((doc) => doc.id === id)?.title ??
    folders.find((f) => f.id === id)?.name;
  const itemDrag = useDragPresentation(itemLabel, { onDragEnd: onSpaceDragEnd });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="mb-1"
    >
      {/*
       * #322: the drag was wired here all along but had NO affordance — computed
       * cursor was `auto`, no grip, nothing in the context menu — so the founder
       * looked, found nothing, and concluded reordering wasn't built. A feature
       * with no affordance is a missing feature.
       *
       * Treatment follows the precedent already paid for on table columns
       * (header-cell.tsx): the WHOLE row is the handle with `cursor-grab`, and
       * the grip is only a hint. That file's comment records why — a 12px
       * opacity-0 grip "was too hard to grab, so reorder felt broken".
       * The PointerSensor's `distance: 6` keeps a plain click navigating.
       */}
      <div
        className="group flex cursor-grab touch-none items-center justify-between px-2 py-1 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical
          className="-ml-1.5 mr-0.5 h-3 w-3 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
        {renaming ? (
          <RenameInline
            initial={space.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== space.name) mutations.updateSpace.mutate({ id: space.id, name });
            }}
          />
        ) : (
          <>
            {/* #449 — the caret is a SEPARATE control from the link, per #382's
                precedent on database rows: "the caret is a separate control from
                the link. Clicking the [row] name must still open it... expanding
                is a different intent and gets its own hit target." The space
                header used to be one <button> doing both; now the caret alone
                toggles collapse and the name navigates to the space's own page,
                which did not exist before #449. */}
            <button
              type="button"
              className="flex shrink-0 items-center text-faint hover:text-muted"
              onClick={toggleCollapsed}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={collapsed ? `Expand ${space.name}` : `Collapse ${space.name}`}
              aria-expanded={!collapsed}
            >
              <ChevronRight
                className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
              />
            </button>
            <Link
              href={`/w/${ws}/s/${space.id}`}
              className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wider text-faint hover:text-muted"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {space.icon && <EntityIcon icon={space.icon} color={space.color} fallback={null} className="text-[13px]" />}
              <span className="truncate">{space.name}</span>
              {collapsed && databases.length > 0 && (
                <span className="ml-1 text-faint/70">{databases.length}</span>
              )}
            </Link>
          </>
        )}
        {canEdit && (
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded p-0.5 text-muted hover:bg-active" title="Add">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setNewDbFolder(null)}>
                  <Database className="mr-2 h-3.5 w-3.5" /> New database
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => createDoc.mutate(null)}>
                  <FileText className="mr-2 h-3.5 w-3.5" /> New document
                </DropdownMenuItem>
                {/* #306 — a dashboard is the one view type that belongs to the
                    SPACE rather than a database: it composes queries instead of
                    rendering rows of one table. */}
                <DropdownMenuItem onSelect={() => createSpaceDashboard.mutate()}>
                  <LayoutDashboard className="mr-2 h-3.5 w-3.5" /> New dashboard
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setDialog({ kind: 'name', title: 'New folder', value: '', submit: (v) => createFolder.mutate(v) });
                  }}
                >
                  <FolderIcon className="mr-2 h-3.5 w-3.5" /> New folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog
              open={newDbFolder !== undefined}
              onOpenChange={(open) => !open && setNewDbFolder(undefined)}
            >
              <NewDatabaseDialog
                onCreate={(name) => {
                  const folderId = newDbFolder ?? null;
                  mutations.createDatabase.mutate(
                    { space_id: space.id, name },
                    {
                      onError: () => toast.error('Could not create database'),
                      onSuccess: (created) => {
                        // #211 — file it, then open it. Same two-step as a
                        // document: `CreateDatabaseDto` has no `folder_id`, the
                        // update does.
                        if (folderId) {
                          mutations.updateDatabase.mutate(
                            { id: created.id, folder_id: folderId },
                            { onError: () => toast.error('Created, but could not put it in the folder') },
                          );
                        }
                        router.push(`/w/${ws}/d/${created.id}`);
                      },
                    },
                  );
                  setNewDbFolder(undefined);
                }}
              />
            </Dialog>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded p-0.5 text-muted hover:bg-active">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDescribing(true)}>
                  {space.description ? 'Edit description' : 'Add description'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setIconing(true)}>Icon & color</DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem onSelect={() => setSharing(true)}>Manage access</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => hide('space', space.id)}>
                  <EyeOff className="mr-2 h-3.5 w-3.5" /> Hide from my sidebar
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-error"
                  onSelect={() => {
                    /*
                     * #417 — this used to delete an empty space on ONE click, with
                     * no dialog and no undo, sitting 25px below the harmless "Hide
                     * from my sidebar". Being red was the entire safeguard.
                     *
                     * A non-empty space was previously REFUSED outright with a
                     * toast. That refusal was the only protection anywhere and it
                     * was client-side only — the API cascaded unconditionally, so
                     * MCP or a script destroyed everything without friction. The
                     * guard now lives in the service; this dialog is the humane
                     * front end to it, not the protection itself.
                     */
                    void (async () => {
                      const count = databases.length;
                      const ok = await confirmDialog(
                        count > 0
                          ? {
                              title: `Delete "${space.name}" and everything in it?`,
                              message:
                                `This permanently deletes ${count} database${count === 1 ? '' : 's'} ` +
                                `(${databases.map((d) => d.name).join(', ')}) and every record in them. ` +
                                `The trash cannot recover any of it.`,
                              confirmLabel: 'Delete space',
                              danger: true,
                              // Typed name, matching what delete_database already
                              // demands for a strictly SMALLER action.
                              requireTyped: space.name,
                            }
                          : {
                              title: `Delete "${space.name}"?`,
                              message: 'This space is empty. Deleting it cannot be undone.',
                              confirmLabel: 'Delete space',
                              danger: true,
                            },
                      );
                      if (!ok) return;
                      mutations.deleteSpace.mutate({
                        id: space.id,
                        ...(count > 0 ? { confirm: space.name } : {}),
                      });
                    })();
                  }}
                >
                  Delete space
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      <Dialog open={sharing} onOpenChange={setSharing}>
        {sharing && <ShareDialog ws={ws} scope={{ space_id: space.id }} scopeName={space.name} />}
      </Dialog>
      <Dialog open={describing} onOpenChange={setDescribing}>
        {describing && (
          <DescriptionDialogContent
            name={space.name}
            noun="space"
            initial={space.description}
            onSave={(description) => {
              mutations.updateSpace.mutate({ id: space.id, description });
              setDescribing(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={iconing} onOpenChange={setIconing}>
        {iconing && (
          <DialogContent title={`Icon for "${space.name}"`} className="max-w-fit">
            <IconColorPicker
              icon={space.icon}
              color={space.color}
              onChange={(patch) => mutations.updateSpace.mutate({ id: space.id, ...patch })}
            />
          </DialogContent>
        )}
      </Dialog>

      {!collapsed && (
        /* #369 — ONE context for the whole space. Two sibling contexts (root
           databases, and one per folder) is why nothing could be dragged BETWEEN
           containers: dnd-kit cannot see across contexts, so a folder in another
           one was never a drop target. */
        <DndContext
          sensors={dbSensors}
          collisionDetection={collisionStrategy}
          {...itemDrag.contextProps}
        >
          {folders.map((folder) => (
            <FolderSection
              key={folder.id}
              ws={ws}
              folder={folder}
              databases={databases.filter((d) => d.folderId === folder.id)}
              views={spaceViews.filter((v) => v.folder_id === folder.id)}
              /* #368 — a folder holds documents too now. The column existed
                 from MN-096 and nothing ever rendered it. */
              documents={(docs.data ?? []).filter((d) => d.folder_id === folder.id)}
              folders={folders}
              onMove={moveToFolder}
              onMoveView={onMoveView}
              onMoveDoc={(id, folderId) => moveDocToFolder.mutate({ id, folderId })}
              onRenameDoc={(id, title) => renameDoc.mutate({ id, title })}
              onDeleteDoc={(id) => deleteDoc.mutate(id)}
              onRenameView={onRenameView}
              onDeleteView={onDeleteView}
              onRenameFolder={onRenameFolder}
              /* #211 — a folder is a container you can put things IN, not only a
                 label you can drag things onto. */
              onFolderIcon={onFolderIcon}
              onNewDatabase={(folderId) => setNewDbFolder(folderId)}
              onNewDocument={(folderId) => createDoc.mutate(folderId)}
              onDeleteFolder={onDeleteFolder}
              setDialog={setDialog}
              pathname={pathname}
              canEdit={canEdit}
              isAdmin={isAdmin}
            />
          ))}
          {(() => {
            const rootDbs = databases.filter((db) => !db.folderId);
            return (
              <RootDropZone spaceId={space.id}>
                <SortableContext items={rootDbs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                  {rootDbs.map((db) => (
                    <DatabaseBranch
                      key={db.id}
                      ws={ws}
                      db={db}
                      views={childViewsOf(db.id)}
                      pathname={pathname}
                      currentViewId={currentViewId}
                      folders={folders}
                      onMove={moveToFolder}
                      onMoveView={onMoveView}
                      onRenameView={onRenameView}
                      onDeleteView={onDeleteView}
                      canEdit={canEdit}
                      isAdmin={isAdmin}
                    />
                  ))}
                </SortableContext>
              </RootDropZone>
            );
          })()}
          {/* #306 — views that belong to the SPACE, not to any database: a
              space-level dashboard. They match no database row above, so
              without this they simply would not render. Foldered ones are
              already drawn by FolderSection. */}
          {spaceViews
            .filter((v) => !v.database_id && !v.folder_id)
            .map((v) => (
              <SidebarViewRow
                key={v.id}
                ws={ws}
                view={v}
                active={pathname === `/w/${ws}/v/${v.id}`}
                folders={folders}
                onMove={onMoveView}
                onRename={onRenameView}
                onDelete={onDeleteView}
                canEdit={canEdit}
                /* #380 — a space-level dashboard is a SIBLING of the databases,
                   so it shares their left edge. It used to render LEFT of them. */
                depth={1}
              />
            ))}
          {/* #368 — only the unfiled ones here; a document in a folder renders
              inside that folder, never in both places. */}
          {(docs.data ?? []).filter((d) => !d.folder_id).map((d) => (
            <DocumentRow
              key={d.id}
              ws={ws}
              doc={d}
              active={pathname === `/w/${ws}/doc/${d.id}`}
              folders={folders}
              onMove={(id, folderId) => moveDocToFolder.mutate({ id, folderId })}
              onRename={(id, title) => renameDoc.mutate({ id, title })}
              onDelete={(id) => deleteDoc.mutate(id)}
              setDialog={setDialog}
            />
          ))}
          <DragPreview>
            {itemDrag.activeId && (
              <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-[3px] text-[13px] text-ink shadow-[0_8px_24px_rgba(15,23,41,0.25)]">
                {itemLabel(itemDrag.activeId) ?? ''}
              </div>
            )}
          </DragPreview>
        </DndContext>
      )}
      {dialog && <PromptDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/**
 * #368 — a document row, extracted so it can render at the space root AND inside
 * a folder.
 *
 * It used to be inline JSX in SpaceSection, which is why it could only ever
 * appear in one place — and why `space_documents.folderId` sat unused from
 * MN-096 until now. #380's shared wrapper is what makes rendering it at two
 * depths safe: the gutter and indent come from the wrapper, so this cannot drift
 * from the databases beside it the way view rows did after #347.
 */
function DocumentRow({
  ws,
  doc,
  active,
  folders,
  onMove,
  onRename,
  onDelete,
  setDialog,
  depth = 1,
  canEdit = true,
}: {
  ws: string;
  doc: { id: string; title: string; icon: string | null; folder_id: string | null };
  active: boolean;
  folders: FolderInfo[];
  onMove: (id: string, folderId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  setDialog: (d: DialogState) => void;
  depth?: SidebarDepth;
  canEdit?: boolean;
}) {
  /** #369 — documents are draggable too, so all three leaf types move the same way. */
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.id,
    data: { kind: 'document' },
    disabled: !canEdit,
  });
  return (
    <SidebarRow
      depth={depth}
      active={active}
      /* `group/doc` removed with #389 — the shared menu's trigger reveals on the
         row's own `group` (supplied by SidebarRow), so the named variant had no
         remaining reference. */
      className={cn(vacatedSlotClass(isDragging))}
      ref={canEdit ? setNodeRef : undefined}
      style={canEdit ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      draggable={canEdit}
      dragHandleProps={canEdit ? { ...attributes, ...listeners } : undefined}
    >
      <Link href={`/w/${ws}/doc/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-2">
        <EntityIcon icon={doc.icon} color={null} fallback={<FileText className="h-3.5 w-3.5 shrink-0 text-muted" />} className="text-[13px]" />
        <span className="truncate">{doc.title || 'Untitled'}</span>
      </Link>
      {/*
        #389 — the document row moves onto the shared menu too.

        Not strictly named by the ticket, which is about DatabaseRow, but it was
        the last row-level menu still owning its own markup, and the AC asks for
        zero. It also carried the very defect #383 fixed on DatabaseRow: the
        trigger had NO aria-label and no `focus:opacity-100`, so a keyboard user
        tabbed onto an invisible, unnamed button. Sharing the component fixes
        that by construction rather than by remembering.
      */}
      <SidebarRowMenu
        label={doc.title || 'Untitled'}
        actions={[
          {
            label: 'Rename',
            onSelect: () =>
              setDialog({ kind: 'name', title: 'Rename document', value: doc.title || '', submit: (v) => onRename(doc.id, v) }),
          },
          ...(folders.length > 0 || doc.folder_id
            ? [
                ...(doc.folder_id
                  ? [
                      {
                        label: '↑ Space root',
                        sectionLabel: 'Move to',
                        separatorBefore: true,
                        onSelect: () => onMove(doc.id, null),
                      },
                    ]
                  : []),
                ...folders
                  .filter((f) => f.id !== doc.folder_id)
                  .map((f, i) => ({
                    label: f.name,
                    icon: <FolderIcon className="mr-2 h-3.5 w-3.5" />,
                    ...(i === 0 && !doc.folder_id
                      ? { sectionLabel: 'Move to', separatorBefore: true }
                      : {}),
                    onSelect: () => onMove(doc.id, f.id),
                  })),
              ]
            : []),
          {
            label: 'Delete',
            danger: true,
            separatorBefore: true,
            onSelect: () =>
              setDialog({ kind: 'confirm', title: `Delete "${doc.title || 'Untitled'}"?`, danger: true, submit: () => onDelete(doc.id) }),
          },
        ]}
      />
    </SidebarRow>
  );
}

/** Styled replacement for window.prompt / window.confirm (MN-24). */
function PromptDialog({
  state,
  onClose,
}: {
  state:
    | { kind: 'name'; title: string; value: string; submit: (v: string) => void }
    | { kind: 'confirm'; title: string; danger?: boolean; submit: () => void };
  onClose: () => void;
}) {
  const [val, setVal] = useState(state.kind === 'name' ? state.value : '');
  const confirm = () => {
    if (state.kind === 'name') {
      if (val.trim()) state.submit(val.trim());
    } else {
      state.submit();
    }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={state.title} className="max-w-sm">
        <div className="flex flex-col gap-3 p-1">
          {state.kind === 'name' && (
            <input
              autoFocus
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
              className="w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none focus:border-border-strong"
            />
          )}
          <div className="flex justify-end gap-2">
            <button className="rounded-[var(--radius-control)] px-3 py-1 text-[13px] text-muted hover:bg-hover" onClick={onClose}>
              Cancel
            </button>
            <button
              className={cn(
                'rounded-[var(--radius-control)] px-3 py-1 text-[13px] font-medium text-white',
                state.kind === 'confirm' && state.danger ? 'bg-error' : 'bg-ink',
              )}
              onClick={confirm}
            >
              {state.kind === 'confirm' ? 'Delete' : 'Save'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FolderInfo {
  id: string;
  name: string;
  icon: string | null;
}

/** A collapsible folder inside a space, holding databases (MN-096). */
function FolderSection({
  ws,
  folder,
  databases,
  views,
  documents,
  folders,
  onMove,
  onMoveView,
  onMoveDoc,
  onRenameDoc,
  onDeleteDoc,
  onRenameView,
  onDeleteView,
  onRenameFolder,
  onDeleteFolder,
  onFolderIcon,
  onNewDatabase,
  onNewDocument,
  setDialog,
  pathname,
  canEdit,
  isAdmin,
}: {
  ws: string;
  folder: FolderInfo;
  databases: DatabaseSummary[];
  /** #347 — a folder holds databases AND views. It held only databases before. */
  views: SidebarView[];
  /** #368 — and documents, whose folder column had been dead since MN-096. */
  documents: Array<{ id: string; title: string; icon: string | null; folder_id: string | null }>;
  folders: FolderInfo[];
  onMove: (dbId: string, folderId: string | null) => void;
  onMoveView: (viewId: string, folderId: string | null) => void;
  onMoveDoc: (id: string, folderId: string | null) => void;
  onRenameDoc: (id: string, title: string) => void;
  onDeleteDoc: (id: string) => void;
  /** #383 — view rows in a folder get the same menu as those outside one. */
  onRenameView: (view: SidebarView) => void;
  onDeleteView: (view: SidebarView) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  /** #211 — folders carry an `icon` column that nothing ever wrote. */
  onFolderIcon: (id: string, icon: string | null) => void;
  /** #211 — create INSIDE this folder, rather than at the space root and then
   *  dragging it in. Both open the space's own creators with a destination. */
  onNewDatabase: (folderId: string) => void;
  onNewDocument: (folderId: string) => void;
  setDialog: (d: DialogState) => void;
  pathname: string;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  /**
   * #369 — the whole folder is the drop target, header included, so it accepts a
   * drop while COLLAPSED. A collapsed folder that rejects drops fails exactly
   * when the sidebar is busy enough to need folding.
   */
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `folder:${folder.id}` });
  // #383 — named once: the header count, the empty-state and the delete
  // confirmation all have to agree about what "inside" means.
  const contentCount = databases.length + views.length + documents.length;
  const [iconing, setIconing] = useState(false);
  const key = `storyos:folder-collapsed:${folder.id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') setCollapsed(window.localStorage.getItem(key) === '1');
  }, [key]);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      if (typeof window !== 'undefined') window.localStorage.setItem(key, next ? '1' : '0');
      return next;
    });

  return (
    <div
      ref={setDropRef}
      className={cn('rounded', isOver && 'bg-hover ring-1 ring-inset ring-accent/40')}
    >
      {/* #380 — a folder sits on the SAME left edge as the databases beside it
          (founder's spec: "folders, dashboards — the same padding left as
          databases"), so it goes through the shared row at depth 1. */}
      {/* #383 — the header is a ROW, not a button.
          It used to be a single <button> wrapping everything, which is why it
          could never grow a menu: a <button> inside a <button> is invalid HTML
          and the inner one does not reliably receive clicks. The toggle is now
          the button and the menu is its sibling, so the folder gets the rename
          and delete every database row has had all along.

          Geometry is unchanged: paddingLeft moved from the button to this row,
          and the caret is still the first thing inside, so #380's measured
          alignment holds. */}
      <div
        style={{ paddingLeft: SIDEBAR_INDENT_PX[1] }}
        /* gap-0 on the outer: the caret's own mr-0.5 IS the gutter margin, and
           an extra flex gap here put the folder icon 4px right of every other
           depth-1 icon. The icon→label gap is applied on the inner span so it
           matches the gap-2 the database/document rows use. */
        className="group flex w-full items-center rounded py-[3px] pr-2 text-[13px] text-ink-secondary hover:bg-hover"
      >
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center text-left">
          {/* #380 — the caret OCCUPIES the gutter slot rather than adding to it.
              A database shows a drag grip there; a folder shows its disclosure
              caret. Same 12px + 2px margin either way, so the icon and label line
              up exactly with the databases beside it. Giving the folder both a
              gutter and a caret pushed its label 17px right — measured, not
              guessed. */}
          <ChevronRight
            className={cn('mr-0.5 h-3 w-3 shrink-0 text-faint transition-transform', !collapsed && 'rotate-90')}
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <EntityIcon icon={folder.icon} color={null} fallback={<FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted" />} className="text-[13px]" />
            <span className="truncate">{folder.name}</span>
          </span>
        </button>
        {contentCount > 0 && (
          <span className="ml-1 shrink-0 text-[11px] text-faint">{contentCount}</span>
        )}
        {canEdit && (
          <SidebarRowMenu
            label={folder.name}
            actions={[
              {
                label: 'Rename',
                onSelect: () =>
                  setDialog({
                    kind: 'name',
                    title: 'Rename folder',
                    value: folder.name,
                    submit: (name) => onRenameFolder(folder.id, name),
                  }),
              },
              // #211 — the same "Icon & color" affordance a space and a database
              // have had all along. A folder has no colour column, so the picker
              // is icon-only; see the dialog below.
              { label: 'Icon', onSelect: () => setIconing(true) },
              // #211 — create INSIDE the folder. Before this a folder was a
              // destination you could only drag into: you made a database at the
              // space root and then moved it, which is why an empty folder read
              // as a dead end.
              {
                label: 'New database',
                icon: <Database className="mr-2 h-3.5 w-3.5" />,
                separatorBefore: true,
                onSelect: () => onNewDatabase(folder.id),
              },
              {
                label: 'New document',
                icon: <FileText className="mr-2 h-3.5 w-3.5" />,
                onSelect: () => onNewDocument(folder.id),
              },
              {
                label: 'Delete',
                danger: true,
                separatorBefore: true,
                onSelect: () =>
                  setDialog({
                    kind: 'confirm',
                    danger: true,
                    /**
                     * #383 — say what SURVIVES, not just what goes. Deleting a
                     * container that might take its contents with it is the
                     * scariest possible unlabelled button, and the answer here is
                     * reassuring: every folder_id is ON DELETE SET NULL, so the
                     * contents really do return to the space root. The sentence
                     * is true by construction, not by convention.
                     */
                    title:
                      contentCount > 0
                        ? `Delete the folder "${folder.name}"? The ${contentCount} ${contentCount === 1 ? 'item inside moves' : 'items inside move'} back to the space — nothing in it is deleted.`
                        : `Delete the folder "${folder.name}"? It is empty.`,
                    submit: () => onDeleteFolder(folder.id),
                  }),
              },
            ]}
          />
        )}
      </div>
      {!collapsed && (
        /* #380 — same guide line, same offset as a database's nested views. */
        <div className="border-l border-border-default" style={{ marginLeft: SIDEBAR_INDENT_PX[1] }}>
          {contentCount === 0 && (
            /* #369 — an empty folder needs a target with HEIGHT. "Empty" text
               alone is a few pixels of hit area, so dropping into a new folder
               would miss almost every time. The buttons #211 adds make it taller,
               not shorter, so that still holds.

               #211 — and it is no longer only a drop target. "Empty" on its own
               was a dead end: the founder's report was a folder showing exactly
               that with no way forward, and dragging is not a way forward if you
               have nothing to drag yet. */
            <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
              <p className="text-[12px] text-faint">Empty — drop something here</p>
              {canEdit && (
                <div className="flex flex-wrap items-center justify-center gap-1">
                  <button
                    type="button"
                    onClick={() => onNewDatabase(folder.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> Database
                  </button>
                  <button
                    type="button"
                    onClick={() => onNewDocument(folder.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> Document
                  </button>
                </div>
              )}
            </div>
          )}
          {/* #369 — no nested DndContext: the space owns the one context now. */}
          <SortableContext items={databases.map((d) => d.id)} strategy={verticalListSortingStrategy}>
              {databases.map((db) => (
                <DatabaseRow
                  key={db.id}
                  ws={ws}
                  db={db}
                  active={pathname.startsWith(`/w/${ws}/d/${db.id}`)}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  folders={folders}
                  onMove={onMove}
                  reorderable={canEdit}
                />
              ))}
          </SortableContext>
          {views.map((v) => (
            <SidebarViewRow
              key={v.id}
              ws={ws}
              view={v}
              active={pathname.startsWith(`/w/${ws}/d/${v.database_id}`)}
              folders={folders}
              onMove={onMoveView}
              onRename={onRenameView}
              onDelete={onDeleteView}
              canEdit={canEdit}
              /* #380/#368 — a FOLDER already supplies the nesting offset, so its
                 children are all depth 1 relative to it. Left at the default 2 a
                 view sat 16px right of the databases and documents in the same
                 folder — the same class of misalignment #380 exists to end,
                 introduced by adding a second row type to this list. */
              depth={1}
            />
          ))}
          {documents.map((d) => (
            <DocumentRow
              key={d.id}
              ws={ws}
              doc={d}
              active={pathname === `/w/${ws}/doc/${d.id}`}
              folders={folders}
              onMove={onMoveDoc}
              onRename={onRenameDoc}
              onDelete={onDeleteDoc}
              setDialog={setDialog}
            />
          ))}
        </div>
      )}
      {/* #211 — icon only, via `showColor={false}`. A folder has an `icon` column
          but no `color` one (UpdateFolderDto is name/icon/position), so a swatch
          here would be a control that accepts a click and changes nothing. */}
      <Dialog open={iconing} onOpenChange={setIconing}>
        {iconing && (
          <DialogContent title={`Icon for "${folder.name}"`} className="max-w-fit">
            <IconColorPicker
              icon={folder.icon}
              color={null}
              showColor={false}
              onChange={(patch) => {
                if (patch.icon !== undefined) onFolderIcon(folder.id, patch.icon);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/**
 * #382 — a database and the views under it, with its own expand state.
 *
 * Its own component because the expand state is a HOOK and this renders inside a
 * .map(). It also puts the caret and the children in one place, so #381's "does
 * this database have children" answer cannot disagree with #382's "should there
 * be a caret".
 */
function DatabaseBranch({
  ws,
  db,
  views,
  pathname,
  currentViewId,
  folders,
  onMove,
  onMoveView,
  onRenameView,
  onDeleteView,
  canEdit,
  isAdmin,
}: {
  ws: string;
  db: DatabaseSummary;
  views: SidebarView[];
  pathname: string;
  currentViewId: string | null;
  folders: FolderInfo[];
  onMove: (dbId: string, folderId: string | null) => void;
  onMoveView: (viewId: string, folderId: string | null) => void;
  /** #383 — a nested view row manages itself like every other row. */
  onRenameView: (view: SidebarView) => void;
  onDeleteView: (view: SidebarView) => void;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const isHere = pathname.startsWith(`/w/${ws}/d/${db.id}`);
  const { expanded, toggle } = useDatabaseExpanded(db.id, isHere);
  // #382 — a caret only where there is something behind it. With #381 removing
  // the default view, most databases have no children at all, which is what
  // makes the sidebar compact rather than merely collapsible.
  const hasChildren = views.length > 0;

  return (
    <Fragment>
      <DatabaseRow
        ws={ws}
        db={db}
        active={isHere}
        canEdit={canEdit}
        isAdmin={isAdmin}
        folders={folders}
        onMove={onMove}
        reorderable={canEdit}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={toggle}
      />
      {hasChildren && expanded &&
        views.map((v) => (
          /* #380 — indent comes from SidebarRow's depth. This wrapper only draws
             the guide line; it used to add ml-4 while a folder's children used
             ml-3, so the two nesting levels disagreed by 4px. */
          <div key={v.id} className="border-l border-border-default" style={{ marginLeft: SIDEBAR_INDENT_PX[1] }}>
            <SidebarViewRow
              ws={ws}
              view={v}
              active={isHere && currentViewId === v.id}
              folders={folders}
              onMove={onMoveView}
              onRename={onRenameView}
              onDelete={onDeleteView}
              canEdit={canEdit}
            />
          </div>
        ))}
    </Fragment>
  );
}

function DatabaseRow({
  ws,
  db,
  active,
  canEdit,
  isAdmin,
  folders = [],
  onMove,
  reorderable = false,
  expandable = false,
  expanded = false,
  onToggle,
}: {
  ws: string;
  db: DatabaseSummary;
  active: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  folders?: FolderInfo[];
  onMove?: (dbId: string, folderId: string | null) => void;
  reorderable?: boolean;
  /** #382 — only true when there is something behind the caret. */
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const mutations = useSidebarMutations(ws);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [iconing, setIconing] = useState(false);
  // #457 — see the note on the space row: a separate item, not folded into Rename.
  const [describing, setDescribing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [automating, setAutomating] = useState(false);
  const { hide } = useHidden(ws);
  // Reorder is suspended while renaming so the inline input keeps pointer focus.
  const canDrag = reorderable && !renaming;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: db.id,
    // #369 — the handler needs to know WHAT was dragged to pick the right move,
    // and which list it came from to reorder within it.
    data: { kind: 'database', folderId: db.folderId ?? null },
    disabled: !canDrag,
  });

  return (
    <SidebarRow
      depth={1}
      active={active}
      draggable={canDrag}
      ref={reorderable ? setNodeRef : undefined}
      style={reorderable ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      className={cn(
        'relative',
        /* #409 — the row no longer paints over its neighbours: the dragged
           content is rendered by the shared <DragPreview> outside the flow, and
           this slot reads as a dimmed placeholder rather than a hole. */
        vacatedSlotClass(isDragging),
        // #322: the row itself is the handle, not only the 12px grip — the exact
        // thing header-cell.tsx records as "too hard to grab, so reorder felt
        // broken" (MN-225).
        canDrag && 'cursor-grab touch-none active:cursor-grabbing',
      )}
      {...(canDrag ? attributes : {})}
      {...(canDrag ? listeners : {})}
      /* #400 — the purpose line is the tooltip when there is one. It beats
         "Drag to reorder": the drag affordance is discoverable by trying it,
         whereas what a database is FOR is discoverable nowhere else in the
         sidebar. Falls back to the drag hint when undescribed. */
      title={db.description || (canDrag ? 'Drag to reorder' : undefined)}
      /* #412 — the insertion marker, derived from `isOver` (the same value the
         drop resolves against), so it can never point somewhere a release would
         not produce. Renders nothing when this row is not the target. */
      indicator={<DropIndicator active={isOver && !isDragging} />}
      /* #380 (follow-up) — the caret goes in the RESERVED gutter, not beside it, so a
         database with children lines up with one without. */
      caret={
        expandable ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${db.name}` : `Expand ${db.name}`}
            aria-expanded={expanded}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle?.();
            }}
            className="rounded text-faint hover:text-ink"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : undefined
      }
    >
      {renaming ? (
        <RenameInline
          initial={db.name}
          onDone={(name) => {
            setRenaming(false);
            if (name && name !== db.name) mutations.updateDatabase.mutate({ id: db.id, name });
          }}
        />
      ) : (
        <>
          {/* #382 — the caret is a SEPARATE control from the link. Clicking the
              database name must still open it (#381 rejected turning the row
              into a pure disclosure toggle); expanding is a different intent and
              gets its own hit target. Rendered only when there is something to
              expand, which after #381 is the minority of databases. */}
        <Link href={`/w/${ws}/d/${db.id}`} className="flex min-w-0 flex-1 items-center gap-2">
          <EntityIcon
            icon={db.icon}
            color={db.color}
            fallback={<Database className="h-3.5 w-3.5 text-muted" />}
          />
          <span className="truncate">{db.name}</span>
        </Link>
        </>
      )}
      {canEdit && !renaming && (
        /*
         * #389 — through the SHARED menu now, not this row's own markup.
         *
         * #383 built SidebarRowMenu and moved the two rows that had NO working
         * menu onto it, deliberately leaving this richer one alone: it was an
         * Urgent fix (dashboards could not be deleted at all) and refactoring a
         * menu that WORKED under that pressure was the wrong trade.
         *
         * The divergence is the mechanism, not the symptom. #380 documented it
         * for indentation and #383 for menus; both times a newer row type failed
         * to inherit what the older ones had, because the behaviour lived per
         * component. One definition means the next row type gets it by
         * construction.
         */
        <SidebarRowMenu
          label={db.name}
          contentClassName="w-56"
          actions={[
            { label: 'Rename', onSelect: () => setRenaming(true) },
            {
              label: db.description ? 'Edit description' : 'Add description',
              onSelect: () => setDescribing(true),
            },
            { label: 'Icon & color', onSelect: () => setIconing(true) },
            { label: 'Import CSV…', onSelect: () => setImporting(true) },
            { label: 'Sync from…', onSelect: () => setSyncing(true) },
            { label: 'Buttons & automations', onSelect: () => setAutomating(true) },
            // `hidden` rather than a conditional spread — see the note on
            // SidebarMenuAction. The item is declared in place and simply not
            // rendered, so it cannot be lost to a misplaced spread.
            { label: 'Manage access', onSelect: () => setSharing(true), hidden: !isAdmin },
            // "Move to" — the section header rides on the FIRST target, so the
            // heading cannot outlive the group it labels.
            ...(onMove && (folders.length > 0 || db.folderId)
              ? [
                  ...(db.folderId
                    ? [
                        {
                          label: '↑ Space root',
                          sectionLabel: 'Move to',
                          separatorBefore: true,
                          onSelect: () => onMove(db.id, null),
                        },
                      ]
                    : []),
                  ...folders
                    .filter((f) => f.id !== db.folderId)
                    .map((f, i) => ({
                      label: f.name,
                      icon: <FolderIcon className="mr-2 h-3.5 w-3.5" />,
                      // Only the first target carries the heading/separator, and
                      // only when "Space root" did not already supply it.
                      ...(i === 0 && !db.folderId
                        ? { sectionLabel: 'Move to', separatorBefore: true }
                        : {}),
                      onSelect: () => onMove(db.id, f.id),
                    })),
                ]
              : []),
            {
              label: 'Hide from my sidebar',
              icon: <EyeOff className="mr-2 h-3.5 w-3.5" />,
              separatorBefore: true,
              onSelect: () => hide('database', db.id),
            },
            { label: 'Trash', href: `/w/${ws}/d/${db.id}/trash` },
            { label: 'Delete database', danger: true, onSelect: () => setConfirmingDelete(true) },
          ]}
        />
      )}
      <Dialog open={sharing} onOpenChange={setSharing}>
        {sharing && <ShareDialog ws={ws} scope={{ database_id: db.id }} scopeName={db.name} />}
      </Dialog>
      <Dialog open={describing} onOpenChange={setDescribing}>
        {describing && (
          <DescriptionDialogContent
            name={db.name}
            noun="database"
            initial={db.description}
            onSave={(description) => {
              mutations.updateDatabase.mutate({ id: db.id, description });
              setDescribing(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={iconing} onOpenChange={setIconing}>
        {iconing && (
          <DialogContent title={`Icon for "${db.name}"`} className="max-w-fit">
            <IconColorPicker
              icon={db.icon}
              color={db.color}
              onChange={(patch) => mutations.updateDatabase.mutate({ id: db.id, ...patch })}
            />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={importing} onOpenChange={setImporting}>
        {importing && <ImportWizard ws={ws} db={db.id} onDone={() => setImporting(false)} />}
      </Dialog>
      <Dialog open={syncing} onOpenChange={setSyncing}>
        {syncing && <SourcesDialog ws={ws} db={db.id} onDone={() => setSyncing(false)} />}
      </Dialog>
      <Dialog open={automating} onOpenChange={setAutomating}>
        {automating && <AutomationsPanel ws={ws} db={db.id} onClose={() => setAutomating(false)} />}
      </Dialog>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DeleteDatabaseDialog
          name={db.name}
          onConfirm={(typed) => {
            mutations.deleteDatabase.mutate(
              { id: db.id, confirm: typed },
              {
                onError: (error) =>
                  toast.error(
                    (error as { error?: { message?: string } })?.error?.message ??
                      'Could not delete the database',
                  ),
                onSuccess: () => toast.success(`Deleted "${db.name}"`),
              },
            );
            setConfirmingDelete(false);
          }}
        />
      </Dialog>
    </SidebarRow>
  );
}

function RenameInline({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="w-full rounded border border-border-strong bg-card px-1 py-0.5 text-[13px] text-ink"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(value.trim());
        if (e.key === 'Escape') onDone(initial);
      }}
    />
  );
}

function NewSpaceButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="mt-1 flex w-full items-center gap-2 rounded px-2 py-[3px] text-[13px] text-muted hover:bg-hover">
          <Plus className="h-3.5 w-3.5" /> New space
        </button>
      </DialogTrigger>
      <DialogContent title="New space">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(name.trim());
            setName('');
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            placeholder="e.g. Client Work"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Create space</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewDatabaseDialog({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <DialogContent title="New database">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
          setName('');
        }}
      >
        <Input
          autoFocus
          placeholder="e.g. Tasks, Articles, Posts"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit">Create database</Button>
        </div>
      </form>
    </DialogContent>
  );
}

function DeleteDatabaseDialog({
  name,
  onConfirm,
}: {
  name: string;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <DialogContent title={`Delete "${name}"?`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === name) onConfirm(typed); // gate Enter too, not just the button
        }}
      >
        <p className="text-[13px] text-muted">
          This permanently deletes the database, its fields, records, views, and any relations
          linking it to other databases. Type{' '}
          <span className="font-semibold text-ink">{name}</span> to confirm.
        </p>
        <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" variant="destructive" disabled={typed !== name}>
            Delete forever
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
