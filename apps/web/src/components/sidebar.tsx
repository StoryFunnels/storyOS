'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { computeReorder } from '@/lib/reorder';
import { atLeast } from '@/lib/access';
import { Activity, Cable, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Database, Eye, EyeOff, FileText, Folder as FolderIcon, LayoutDashboard, GitPullRequest, Home, Inbox, Keyboard, KeyRound, LayoutTemplate, MoreHorizontal, Package, Plug, Plus, Search, Settings, Star, UserRound, Webhook, X} from 'lucide-react';
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
import { useDatabases, useSidebarMutations, useSpaceGroups, useSpaces, useWorkspace } from '@/lib/queries';
import { useHidden } from '@/lib/hidden-sidebar';
import { useViewsOnlyMode } from '@/lib/views-only-mode';
import type { DatabaseSummary, Space, SpaceGroup } from '@/lib/queries';
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
import {
  SIDEBAR_NAV_DEFAULT_W,
  SIDEBAR_NAV_MAX_W,
  SIDEBAR_NAV_MIN_W,
  SIDEBAR_NAV_STEP,
  clampSidebarNavWidth,
  useSidebarNavWidth,
} from '@/lib/sidebar-width';
import { SidebarViewRow, type SidebarView } from '@/components/sidebar-view-row';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';
import { PersonalSection } from '@/components/personal-section';

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
      <div className="px-2 pb-1 text-meta font-semibold uppercase tracking-wider text-muted">Favorites</div>
      <div className="flex flex-col gap-0.5">
        {items.map((f) => (
          <Link
            key={`${f.target_type}:${f.target_id}`}
            href={f.target_type === 'record' ? `/w/${ws}/d/${f.database_id}/r/${f.target_id}` : `/w/${ws}/d/${f.target_id}`}
            className="flex items-center gap-2 rounded px-2 py-[3px] text-body text-ink-secondary hover:bg-hover"
          >
            <Star className="h-3.5 w-3.5 shrink-0 fill-[var(--accent)] text-[var(--accent)]" />
            <span className="overflow-hidden whitespace-nowrap">{f.title}</span>
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
  const groups = useSpaceGroups(ws);
  const mutations = useSidebarMutations(ws);

  const canEdit = workspace.data?.role !== 'guest';
  const isAdmin = workspace.data?.role === 'admin';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  // #396 — platform-correct display keys; see the comment at the Search row.
  const paletteKeys = useShortcutKeys('palette');
  const unread = useUnreadCount(ws);
  const { isHidden, unhide } = useHidden(ws);
  const { viewsOnly, toggle: toggleViewsOnly } = useViewsOnlyMode(ws);

  // Personal hide (#35): hidden spaces drop out entirely; a database hidden on its own
  // (its space still visible) drops out too. Both surface in the Hidden section.
  //
  // #769 — the personal space is excluded from this generic tree entirely, not
  // just when hidden. It already has its own dedicated section (PersonalSection,
  // below) with its own menu (Rename / Move to shared space / Delete) — per
  // docs/architecture/personal-space.md, it "isn't just another space in the
  // list." Rendering it here too pointed the SAME document at two rows with two
  // different, disagreeing menus (the generic one offers "Copy to My Space" on
  // a doc that's already personal, and has no "Move to shared space" at all).
  const allSpaces = spaces.data ?? [];
  const allDatabases = databases.data ?? [];
  const visibleSpaces = allSpaces.filter((s) => !isHidden('space', s.id) && !s.personal);
  const hiddenSpaces = allSpaces.filter((s) => isHidden('space', s.id));
  const hiddenDatabases = allDatabases.filter((d) => isHidden('database', d.id) && !isHidden('space', d.spaceId));

  /**
   * #742 finding 04 — Groups render as a tier ABOVE ungrouped spaces, each
   * group showing its own member spaces in their existing position order.
   * PRESENTATIONAL ONLY (Otto's 2026-09-24 ruling): this is purely a render
   * grouping over the same `visibleSpaces` list — it changes nothing about
   * which spaces a viewer can reach, only where they're drawn. No access
   * check anywhere reads `groupId`.
   */
  const sortedGroups = [...(groups.data ?? [])].sort((a, b) => a.position - b.position);
  const spacesByGroup = new Map<string, Space[]>();
  for (const space of visibleSpaces) {
    if (!space.groupId) continue;
    const list = spacesByGroup.get(space.groupId) ?? [];
    list.push(space);
    spacesByGroup.set(space.groupId, list);
  }
  const ungroupedSpaces = visibleSpaces.filter((s) => !s.groupId || !spacesByGroup.has(s.groupId));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /**
   * #742 phase 5 — a container (a group's own area, or the ungrouped zone)
   * wins over a plain space row under the pointer, same reasoning as the
   * per-space collision strategy one level down (`SpaceSection`'s own
   * `collisionStrategy`): a container is a tall droppable whose CENTRE is
   * far from the pointer, so bare `closestCenter` never picks it over a
   * small sortable row. `pointerWithin` asks what's actually under the
   * pointer instead. A row under the pointer still wins when both match —
   * that is an ordinary reorder, not a group move — so this only changes
   * behaviour when the pointer is over EMPTY space inside a group/the
   * ungrouped zone (no row there to prefer).
   *
   * #774 — a GROUP itself is now ALSO a sortable row (reordering groups
   * relative to each other), which means every group header carries TWO
   * ids on the same element: `group:<id>` (the existing container-drop
   * target, for a SPACE joining it) and the bare `<id>` (its own sortable
   * row, for GROUP reordering). Both can be simultaneously "under the
   * pointer" at once, so which one wins depends on what is actually being
   * dragged — a bare-id row must never win while a SPACE is being dragged
   * (that would silently break "drop a space on a group to join it"), and
   * only a bare-id row may ever win while a GROUP is being dragged (a
   * group has no "container" or "ungrouped" concept to join).
   */
  const spaceCollisionStrategy = (args: Parameters<typeof pointerWithin>[0]) => {
    const activeId = String(args.active.id);
    const within = pointerWithin(args);
    if (sortedGroups.some((g) => g.id === activeId)) {
      const groupRow = within.find((c) => sortedGroups.some((g) => g.id === String(c.id)));
      if (groupRow) return [groupRow];
      return closestCenter(args);
    }
    const container = within.find((c) => String(c.id).startsWith('group:') || String(c.id) === 'ungrouped');
    const row = within.find(
      (c) =>
        !String(c.id).startsWith('group:') &&
        String(c.id) !== 'ungrouped' &&
        !sortedGroups.some((g) => g.id === String(c.id)),
    );
    if (row) return [row];
    if (container) return [container];
    return closestCenter(args);
  };

  function onSpaceDragEnd(event: DragEndEvent) {
    const over = event.over;
    if (!over) return;
    const activeId = String(event.active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // #774 — a GROUP being dragged onto another group's own row: reorder the
    // groups themselves, persisted via space_groups.position. The collision
    // strategy above only ever resolves `over` to another group's bare id
    // for this case, so there is nothing else this branch needs to rule out.
    const activeGroup = sortedGroups.find((g) => g.id === activeId);
    if (activeGroup) {
      for (const move of computeReorder(sortedGroups, activeId, overId)) {
        mutations.updateGroup.mutate(move);
      }
      return;
    }

    // Dropped on a GROUP's own area, or the ungrouped zone: reassign the
    // space's group. Presentational only (#742 finding 04) — this writes
    // groupId, never anything access-related, and never touches position.
    if (overId.startsWith('group:')) {
      mutations.updateSpace.mutate({ id: activeId, groupId: overId.slice('group:'.length) });
      return;
    }
    if (overId === 'ungrouped') {
      mutations.updateSpace.mutate({ id: activeId, groupId: null });
      return;
    }

    // Dropped on another SPACE row: reorder over the full space list
    // (positions are shared across every space regardless of group), so
    // dragging a space across several slots shifts the run instead of
    // swapping endpoints. Dropping next to a GROUPED space also joins that
    // group — the natural reading of "I put it here" when "here" already
    // has a colour — while dropping next to an ungrouped one clears it,
    // both via the same one-field patch as the explicit drop zones above.
    const targetSpace = visibleSpaces.find((s) => s.id === overId);
    for (const move of computeReorder(spaces.data ?? [], activeId, overId)) {
      if (move.id === activeId && targetSpace) {
        mutations.updateSpace.mutate({ ...move, groupId: targetSpace.groupId ?? null });
      } else {
        mutations.updateSpace.mutate(move);
      }
    }
  }

  /*
   * #409/#412/#415 — one hook supplies the overlay tracking and the spoken
   * announcements. `label` maps a sortable id to a NAME, which is the whole fix
   * for #415: every sortable in this app is keyed by uuid, so dnd-kit's stock
   * strings read out hex ("Picked up draggable item 102568ca-…").
   *
   * #774 — extended to also resolve a GROUP's own id/name, since a group is
   * now itself draggable.
   */
  const spaceDrag = useDragPresentation(
    (id) => visibleSpaces.find((sp) => sp.id === id)?.name ?? sortedGroups.find((g) => g.id === id)?.name,
    { onDragEnd: onSpaceDragEnd },
    [...visibleSpaces.map((sp) => sp.id), ...sortedGroups.map((g) => g.id)],
  );

  // #742 — draggable width (220–460px), replacing the old fixed `w-60`.
  const { width: sidebarWidth, setWidth: setSidebarWidth, persist: persistSidebarWidth } =
    useSidebarNavWidth();

  return (
    <div className="relative flex h-full shrink-0">
    {/*
     * #742 phase 6 — rail + panel (Direction B). Two axes, one rule each: the
     * RAIL is StoryOS's own surfaces (Home, Inbox, My Work, Runs, Settings —
     * fixed, five items, never grows with a workspace's spaces), the PANEL is
     * this workspace's contents (Collections, Groups, Spaces). Search and Ask
     * Tyron merge into the panel's one ⌘K box rather than each keeping a rail
     * slot; Reviews and Business Packs become Collections rows in the panel
     * rather than rail icons — see the artifact's own nav-IA mapping, ticket
     * #742 comment 2026-09-28T15:33:58Z, restated there because it had lived
     * only in an artifact before and cost a round trip.
     */}
    <SidebarRail
      ws={ws}
      workspaceName={workspace.data?.name}
      isAdmin={isAdmin}
      canEdit={canEdit}
      onSignOut={signOut}
      unreadCount={unread.data ?? 0}
      onOpenInbox={() => setInboxOpen(true)}
    />
    <aside
      style={{ width: sidebarWidth }}
      className="flex h-full shrink-0 flex-col border-r border-border-default bg-sidebar"
    >
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

      {/* #742 phase 6 — the merged search box: one affordance for both Search
          and Ask Tyron (previously two separate top-nav rows). Ask Tyron still
          has its own global ⌘J binding (lib/shortcuts.ts) even without its own
          row here — this box's click always opens the command palette. */}
      <div className="shrink-0 border-b border-border-default px-2 py-1.5">
        <button
          className="flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-body text-faint hover:border-border-strong"
          onClick={openPalette}
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left">Search or ask Tyron</span>
          {/* #254 — from the shared registry, so it can't drift from the
              binding. #396 — rendered for THIS reader's platform. */}
          <span className="text-micro text-muted">{paletteKeys}</span>
        </button>
      </div>
      {inboxOpen && <InboxPanel ws={ws} onClose={() => setInboxOpen(false)} />}

      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-0.5">
        <FavoritesSection ws={ws} />
        {/* #742 phase 6 — Collections tier: Reviews and Business Packs (both
            without a count or an add button — this app has no count source for
            either yet, and inventing one wasn't this ticket's job) plus
            Personal. Personal's own section keeps its existing behaviour
            (New doc/view, its own docs+views list) — the artifact's Collections
            row for Personal shows no count or add button, which the design
            comment reads as deliberate ("a destination, not a container you
            add into from the sidebar"), but removing that capability entirely
            would be a functional regression this ticket isn't scoped to make;
            it stays, just grouped under this banner instead of its own. */}
        <p className="mb-0.5 mt-1 px-2 text-meta font-semibold uppercase tracking-wider text-faint">
          Collections
        </p>
        {/* #779 — through SidebarRow like every other row, rather than a bare
            `<Link>`: neither of these has a chevron, but the reserved gutter
            still applies (Dara's spec: Collections rows measure the SAME
            icon/label offset as every other row type), so a bare link with
            no gutter landed 6px left of where it should. */}
        <SidebarRow depth={0} className="hover:bg-hover">
          <Link href={`/w/${ws}/reviews`} className="flex min-w-0 flex-1 items-center gap-2 text-body text-ink-secondary">
            <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">Reviews</span>
          </Link>
        </SidebarRow>
        <SidebarRow depth={0} className="hover:bg-hover">
          <Link href={`/w/${ws}/packs`} className="flex min-w-0 flex-1 items-center gap-2 text-body text-ink-secondary">
            <Package className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">Business Packs</span>
          </Link>
        </SidebarRow>
        {/* #292 — separate from the shared Spaces tree below: it can't be
            shared, moved into a folder, or deleted like a space can. */}
        <PersonalSection ws={ws} />
        {/* #641 — 72px of the void between the nav and the tree was Personal's
            own mb-2 stacked with this mt-1; trimmed to mt-0 since Personal's
            bottom margin already separates the two sections. */}
        <div className="mb-0.5 mt-0 flex items-center justify-between px-2">
          <span className="text-meta font-semibold uppercase tracking-wider text-muted">Spaces</span>
          <div className="flex items-center gap-0.5">
            <ViewsOnlyModeButton active={viewsOnly} onToggle={toggleViewsOnly} />
            {canEdit && (
              <NewGroupButton onCreate={(name) => mutations.createGroup.mutate({ name })} />
            )}
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
        </div>
        {/* #409/#412/#415 — the shared drag presentation: a portalled preview so
            the dragged row cannot paint over its neighbours, and announcements
            that name the space instead of reading out its uuid. */}
        <DndContext
          sensors={sensors}
          collisionDetection={spaceCollisionStrategy}
          {...spaceDrag.contextProps}
        >
          {/* #641 — a gap here (not padding on the header) separates one
              space from the next: gap only applies BETWEEN siblings, so it
              adds the breathing room a later space's header needs without
              also padding out the void above the very FIRST space, the way
              padding on every header would. */}
          <div className="flex flex-col gap-2">
          {/* #774 — groups get their OWN SortableContext, nested alongside the
              spaces one rather than inside it: two independent id spaces
              (group ids vs space ids) that never collide, so dnd-kit can
              track "reorder among groups" and "reorder/reassign among
              spaces" as two separate sortable lists sharing one DndContext. */}
          <SortableContext items={sortedGroups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <SortableContext items={visibleSpaces.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {sortedGroups.map((group) => {
              // #742 finding 04/phase 5 — a group with no members yet still
              // renders (header only): drag-and-drop reassignment needs a
              // REAL drop target to move the first space into, and an empty
              // group that's invisible until it already has a member is a
              // target nobody can ever reach.
              const members = spacesByGroup.get(group.id) ?? [];
              return (
                <div key={group.id} className="flex flex-col gap-1.5">
                  <GroupDropZone groupId={group.id}>
                    <GroupHeaderRow
                      group={group}
                      canEdit={canEdit}
                      onRename={(name) => mutations.updateGroup.mutate({ id: group.id, name })}
                      onDelete={() => mutations.deleteGroup.mutate(group.id)}
                    />
                  </GroupDropZone>
                  <div className="flex flex-col gap-2">
                    {members.map((space) => (
                      <SpaceSection
                        key={space.id}
                        ws={ws}
                        space={space}
                        databases={allDatabases.filter((d) => d.spaceId === space.id && !isHidden('database', d.id))}
                        canEdit={canEdit}
                        isAdmin={isAdmin}
                        groups={sortedGroups}
                        onMoveToGroup={(groupId) => mutations.updateSpace.mutate({ id: space.id, groupId })}
                        viewsOnly={viewsOnly}
                        stickyTop={GROUP_BAND_H}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {/* #742 phase 5 — always a real drop target, even with zero
                ungrouped spaces right now (e.g. everything already grouped):
                dragging a space out of every group has to land somewhere. */}
            <UngroupedDropZone>
              {ungroupedSpaces.map((space) => (
                <SpaceSection
                  key={space.id}
                  ws={ws}
                  space={space}
                  databases={allDatabases.filter((d) => d.spaceId === space.id && !isHidden('database', d.id))}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  groups={sortedGroups}
                  onMoveToGroup={(groupId) => mutations.updateSpace.mutate({ id: space.id, groupId })}
                  viewsOnly={viewsOnly}
                />
              ))}
            </UngroupedDropZone>
          </SortableContext>
          </SortableContext>
          </div>
          <DragPreview>
            {spaceDrag.activeId && (
              <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-[3px] text-meta font-semibold uppercase tracking-wider text-muted shadow-[var(--shadow-lifted)]">
                {visibleSpaces.find((sp) => sp.id === spaceDrag.activeId)?.name ??
                  sortedGroups.find((g) => g.id === spaceDrag.activeId)?.name ??
                  ''}
              </div>
            )}
          </DragPreview>
        </DndContext>

        {canEdit && <NewSpaceButton onCreate={(name) => mutations.createSpace.mutate({ name })} />}
        {canEdit && (
          <>
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-body text-muted hover:bg-hover"
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
    </aside>
      <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} onCommit={persistSidebarWidth} />
    </div>
  );
}

/**
 * #742 finding 13 — drag the right edge (220–460px), double-click to reset,
 * arrow keys when focused. Deliberately simpler than record-detail's
 * `ResizeHandle`: this sidebar isn't squeezing a measured sibling body, it
 * sits beside the whole app's content area, so there's no container-width
 * reservation math here — just the fixed [MIN, MAX] clamp.
 */
function SidebarResizeHandle({
  width,
  onResize,
  onCommit,
}: {
  width: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Keep the latest width in a ref so the window listeners (bound once) read
  // the current value without re-subscribing on every resize.
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const s = drag.current;
      if (!s) return;
      onResize(clampSidebarNavWidth(s.startW + (e.clientX - s.startX)));
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      onCommit(widthRef.current);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onResize, onCommit]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_NAV_MIN_W}
      aria-valuemax={SIDEBAR_NAV_MAX_W}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startW: width };
        setDragging(true);
      }}
      onDoubleClick={() => onCommit(SIDEBAR_NAV_DEFAULT_W)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onCommit(clampSidebarNavWidth(width - SIDEBAR_NAV_STEP));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onCommit(clampSidebarNavWidth(width + SIDEBAR_NAV_STEP));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onCommit(SIDEBAR_NAV_DEFAULT_W);
        }
      }}
      className={cn(
        'group relative hidden shrink-0 cursor-col-resize touch-none self-stretch md:block',
        '-mx-2 w-4 z-10',
        dragging && 'select-none',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          dragging
            ? 'bg-accent'
            : 'bg-border-default group-hover:bg-border-strong group-focus-visible:bg-border-strong',
        )}
      />
    </div>
  );
}

/**
 * #570 — the account/admin block (Settings & members, Integrations,
 * Connections, Webhooks, API tokens, Keyboard shortcuts, Sign out) behind one
 * icon in the header row, next to the workspace switcher. Previously a
 * permanent 7-row block between the Spaces tree and the bottom of the
 * sidebar; every item here is unchanged in reachability (still one click,
 * just via a menu instead of a fixed row) — #396's "always visible" reasoning
 * for Keyboard shortcuts was about discovery-to-effort ratio for a NEW user,
 * which a `?`-hinted menu item preserves well enough, and #570 explicitly
 * prioritizes the Spaces tree's room over that for every returning user.
 */
function AccountMenu({
  ws,
  isAdmin,
  canEdit,
  onSignOut,
}: {
  ws: string;
  isAdmin: boolean;
  canEdit: boolean;
  onSignOut: () => void | Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Settings & account"
          aria-label="Settings & account"
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-ink"
        >
          <Settings className="h-[17px] w-[17px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-52">
        {isAdmin && (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/settings/members`}>
                <Settings className="h-3.5 w-3.5" /> Settings & members
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/settings/integrations`}>
                <Plug className="h-3.5 w-3.5" /> Integrations
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/settings/connections`}>
                <Cable className="h-3.5 w-3.5" /> Connections
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/settings/webhooks`}>
                <Webhook className="h-3.5 w-3.5" /> Webhooks
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {canEdit && (
          <DropdownMenuItem asChild>
            <Link href={`/w/${ws}/settings/api`}>
              <KeyRound className="h-3.5 w-3.5" /> API tokens
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={openShortcuts}>
          <Keyboard className="h-3.5 w-3.5" /> Keyboard shortcuts
          <span className="ml-auto text-micro text-muted">?</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void onSignOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * #742 phase 6 — the rail: StoryOS's own surfaces, fixed at 52px and five
 * items regardless of how many spaces a workspace has ("neither axis can
 * crowd the other out" — the artifact's own load-bearing rule, ticket #742
 * comment 2026-09-28T15:36:13Z). Icon-only with a native `title` tooltip on
 * every button — the artifact's own cost note is explicit that icon-only nav
 * is learned wrong without one, so this isn't optional polish.
 */
function SidebarRail({
  ws,
  workspaceName,
  isAdmin,
  canEdit,
  onSignOut,
  unreadCount,
  onOpenInbox,
}: {
  ws: string;
  workspaceName?: string;
  isAdmin: boolean;
  canEdit: boolean;
  onSignOut: () => void | Promise<void>;
  unreadCount: number;
  onOpenInbox: () => void;
}) {
  const pathname = usePathname();
  const isHome = pathname === `/w/${ws}`;
  const isMyWork = pathname === `/w/${ws}/me`;
  const isRuns = pathname === `/w/${ws}/runs` || pathname?.startsWith(`/w/${ws}/runs/`);

  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border-default bg-hover/40 py-2">
      <RailWorkspaceButton ws={ws} name={workspaceName} />
      <div className="my-1 h-px w-5 bg-border-strong" aria-hidden />
      <RailLink href={`/w/${ws}`} title="Home" active={isHome}>
        <Home className="h-[17px] w-[17px]" />
      </RailLink>
      {/* #742 phase 6 — a real count only for Inbox (useUnreadCount already
          exists). My Work has no count endpoint yet — /my-work paginates —
          so it gets no badge rather than a guessed one; see Tyron's own
          "never guess numbers" rule for why a confident wrong count is worse
          than none. */}
      <RailButton title="Inbox" onClick={onOpenInbox} badge={unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : undefined}>
        <Inbox className="h-[17px] w-[17px]" />
      </RailButton>
      <RailLink href={`/w/${ws}/me`} title="My Work" active={isMyWork}>
        <UserRound className="h-[17px] w-[17px]" />
      </RailLink>
      <div className="my-1 h-px w-5 bg-border-strong" aria-hidden />
      <RailLink href={`/w/${ws}/runs`} title="Runs" active={isRuns}>
        <Activity className="h-[17px] w-[17px]" />
      </RailLink>
      <div className="flex-1" />
      <AccountMenu ws={ws} isAdmin={isAdmin} canEdit={canEdit} onSignOut={onSignOut} />
    </div>
  );
}

function RailLink({
  href,
  title,
  active,
  children,
}: {
  href: string;
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      className={cn(
        'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-ink',
        active && 'bg-active text-ink',
      )}
    >
      {children}
    </Link>
  );
}

function RailButton({
  title,
  onClick,
  badge,
  children,
}: {
  title: string;
  onClick: () => void;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-ink"
    >
      {children}
      {badge && (
        <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold text-[var(--text-on-dark)]">
          {badge}
        </span>
      )}
    </button>
  );
}

/** #742 phase 6 — the rail's own workspace avatar/switcher; shares the same
 * ['workspaces'] query as the panel header's `WorkspaceSwitcher` (react-query
 * dedupes identical keys, so this is one network call, not two). The panel
 * header keeps its own full switcher too — the artifact's decision was to
 * keep BOTH, not have the rail avatar replace it. */
function RailWorkspaceButton({ ws, name }: { ws: string; name?: string }) {
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
        <button
          title={name ?? 'Switch workspace'}
          aria-label="Switch workspace"
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-primary text-body font-bold text-[var(--text-on-dark)] hover:opacity-90"
        >
          {name?.[0]?.toUpperCase() ?? 'S'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {(workspaces.data ?? []).map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}`)}>
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{w.name}</span>
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
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-meta font-bold text-[var(--text-on-dark)]">
            {currentName?.[0]?.toUpperCase() ?? 'S'}
          </div>
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm font-semibold text-ink">
            {currentName ?? '…'}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {(workspaces.data ?? []).map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}`)}>
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{w.name}</span>
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
        className="flex w-full items-center gap-1 px-2 py-1 text-meta font-semibold uppercase tracking-wider text-muted hover:text-ink-secondary"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        Hidden{' '}
        {/* #665 — the COUNT stays faint on purpose, and so do the two other
            counts in this file (a space's database count, a folder's content
            count). #326's rule is that faint is for genuinely decorative text;
            a number beside a label you can already read is the textbook case.
            The label moved to muted because it is a button; the count did not,
            because raising it would flatten the pair into one weight and lose
            the label-then-count reading. Not an oversight — do not "finish" it. */}
        <span className="ml-0.5 font-normal normal-case text-faint">{count}</span>
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
    <div className="group/h flex items-center justify-between rounded px-2 py-[3px] text-body text-muted">
      <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
        <EntityIcon icon={icon} color={color} fallback={<Database className="h-3.5 w-3.5 text-faint" />} />
        <span className="overflow-hidden whitespace-nowrap">{name}</span>
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
 * #369 — the space root as a drop target, so a leaf can be dragged OUT of a
 * folder (and a view out from under its database) rather than only in.
 *
 * Without an explicit target for "no folder" the only way back out was the menu,
 * which would have left drag as a one-way trip.
 */
function RootDropZone({ spaceId, children }: { spaceId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `root:${spaceId}` });
  return (
    <div
      ref={setNodeRef}
      // #641 — every root database in the space shares this ONE wrapper, so
      // the gap-0.5 on the SpaceSection's outer flex-col (siblings: folders,
      // this block, space-level views, docs) never reached the rows INSIDE
      // it. This is the div actually stacking Members/Agents/Runs etc., so
      // the fix belongs here.
      className={cn('flex flex-col gap-0.5 rounded', isOver && 'bg-hover ring-1 ring-inset ring-accent/40')}
    >
      {children}
    </div>
  );
}

/**
 * #742 phase 5 — a group's HEADER (not the members below it — those render in
 * a sibling div back in `Sidebar()`) is a real drop target for reassigning a
 * space's group, the same container-drop shape `RootDropZone`/a folder
 * already use one level down: dropping a space here resolves to "join this
 * group" once the container-preferring collision strategy picks it.
 *
 * #774 — ALSO a sortable row now, for reordering groups relative to each
 * other. Two ids share this one element: `group:<id>` (the droppable above,
 * for a SPACE joining it) and the sortable's own bare `<id>` (for GROUP
 * reordering) — `spaceCollisionStrategy` picks between them by checking what
 * is actually being dragged, so the two never fight over the same drop.
 * `useSortable` already returns a combined draggable+droppable node; the
 * plain `useDroppable` above is a SECOND, independent registration on the
 * same DOM node (a supported dnd-kit pattern — see e.g. their own
 * multi-container examples, where a column is both sortable-among-columns
 * and droppable-for-cards), so both refs are set together below.
 */
function GroupDropZone({ groupId, children }: { groupId: string; children: React.ReactNode }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `group:${groupId}` });
  const { attributes, listeners, setNodeRef: setSortRef, transform, transition } = useSortable({ id: groupId });
  return (
    <SidebarRow
      depth={0}
      ref={(node) => {
        setDropRef(node);
        setSortRef(node);
      }}
      // #742 phase 6 — sticky, opaque (bg-sidebar), and above the space
      // headers stacking beneath it (z-30 > SpaceSection's z-20): "at twenty
      // rows deep you still read which group you're in" is the artifact's own
      // stated reason this is load-bearing rather than decorative. GROUP_BAND_H
      // is the exact height a SpaceSection's own sticky header offsets against.
      // #774 — also carries the sortable's own transform/transition, so a
      // group-reorder drag still moves this element; sticky positioning only
      // matters while NOT dragging (transform is `none` then), and mid-drag a
      // portalled DragPreview represents it instead.
      //
      // #779 — this row now goes through `SidebarRow` too: it previously
      // reserved no gutter at all (its `LetterMark` sat directly at `px-2`),
      // which is a NARROWER version of the same bug the space header had —
      // draggable, no caret, so the gutter shows the same hover-grip
      // `DatabaseRow` already uses for a plain (non-expandable) reorderable
      // row; there is no group-collapse feature to put in `caret` here.
      style={{ height: GROUP_BAND_H, transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'sticky top-0 z-30 h-auto cursor-grab touch-none bg-sidebar active:cursor-grabbing',
        isOver && 'bg-hover ring-1 ring-inset ring-accent/40',
      )}
      draggable
      {...attributes}
      {...listeners}
    >
      {children}
    </SidebarRow>
  );
}

/** #742 phase 6 — the group band's fixed height, shared by `GroupDropZone`
 * (which sticks at top:0) and every `SpaceSection` header inside a group
 * (which stick at top:GROUP_BAND_H, right below it) — a magic-number
 * mismatch between the two would either leave a gap or overlap. */
const GROUP_BAND_H = 26;

/** #742 phase 5 — the ungrouped list's own drop target, so dragging a space
 *  out of every group has somewhere to land even when the list is currently
 *  empty (everything already grouped) and there's no sibling row to drop near. */
function UngroupedDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'ungrouped' });
  return (
    <div
      ref={setNodeRef}
      className={cn('flex min-h-2 flex-col gap-2 rounded', isOver && 'bg-hover ring-1 ring-inset ring-accent/40')}
    >
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
  groups,
  onMoveToGroup,
  viewsOnly,
  stickyTop = 0,
}: {
  ws: string;
  space: Space;
  databases: DatabaseSummary[];
  canEdit: boolean;
  isAdmin: boolean;
  /** #742 finding 04 — the workspace's groups, for the "Move to group" menu. */
  groups?: SpaceGroup[];
  onMoveToGroup?: (groupId: string | null) => void;
  /** #742 finding 05 — hide every database row, keep their views. */
  viewsOnly?: boolean;
  /** #742 phase 6 — where this space's own sticky header pins: 0 for an
   * ungrouped space (nothing sticks above it), `GROUP_BAND_H` for a space
   * inside a group (stacks right below that group's own sticky band). */
  stickyTop?: number;
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
  /** #293 — "Copy to My Space": fork a shared document into an independent
   * personal copy, never sync'd back. Invalidates the PERSONAL docs list
   * (personal-section.tsx's `['space-docs', ws, <personal space id>]`), not
   * this space's own — the copy lands there, not here. */
  const copyDocToPersonal = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/documents/{doc}/copy-to-personal', {
        params: { path: { ws, doc: id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['space-docs', ws] });
      toast.success('Copied to My Space');
    },
    onError: () => toast.error('Could not copy document'),
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
    <div className="mb-1">
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
       *
       * #779 — this row now goes THROUGH `SidebarRow` instead of being its own
       * bespoke flex row. It never was: it kept its own grip, its own chevron
       * as a sibling of the icon rather than inside the reserved gutter, and
       * its own manual padding, entirely outside sidebar-row.tsx's mechanism —
       * exactly the failure #380's own comment predicts for a component that
       * bypasses it (measured live: the child DATABASE row, which DOES go
       * through SidebarRow, landed 2px LEFT of this space header's icon,
       * instead of 20px right, because this row was reserving a grip AND a
       * chevron side by side where SidebarRow reserves exactly one).
       */}
      <SidebarRow
        depth={0}
        ref={setNodeRef}
        // #641 — was py-1 (4/4); the inter-space breathing room now comes
        // from the space-list's own gap-2 (added between siblings only, so
        // it doesn't also pad out the void above the FIRST space). This stays
        // small and close to its label rather than double-counting that gap.
        //
        // #742 phase 6 — sticky and opaque (bg-sidebar), pinned right below
        // this space's own group band (stickyTop is 0 or GROUP_BAND_H — see
        // the SpaceSection prop doc) so at real scale (52 nodes) you still
        // read which space you're in. z-20, under the group band's z-30 so
        // the two stack instead of one painting over the other.
        style={{ top: stickyTop, transform: CSS.Transform.toString(transform), transition }}
        className="group sticky z-20 h-6 cursor-grab touch-none bg-sidebar active:cursor-grabbing"
        draggable
        {...attributes}
        {...listeners}
        /* #449 — the caret is a SEPARATE control from the link: clicking the
           row name must still open it, expanding is a different intent and
           gets its own hit target. Falls back to SidebarRow's own grip
           (draggable, no caret) while renaming, since there's nothing to
           collapse-toggle in that state. */
        caret={
          renaming ? undefined : (
            <button
              type="button"
              className="text-faint hover:text-muted"
              onClick={toggleCollapsed}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={collapsed ? `Expand ${space.name}` : `Collapse ${space.name}`}
              aria-expanded={!collapsed}
            >
              <ChevronRight
                className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
              />
            </button>
          )
        }
      >
        {renaming ? (
          <RenameInline
            initial={space.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== space.name) mutations.updateSpace.mutate({ id: space.id, name });
            }}
          />
        ) : (
          <Link
            href={`/w/${ws}/s/${space.id}`}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-meta font-medium uppercase tracking-wider text-muted hover:text-ink-secondary"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {space.icon ? (
              <EntityIcon icon={space.icon} color={space.color} fallback={null} className="text-body" />
            ) : (
              /* #742 finding 08 — glyph vocabulary: a space with no custom
                 icon gets a coloured letter mark, same primitive Groups
                 already use, rather than rendering nothing at all. A
                 space WITH a custom icon keeps it — this never overrides
                 a deliberate choice. */
              <LetterMark name={space.name} color={space.color} />
            )}
            <span className="overflow-hidden whitespace-nowrap">{space.name}</span>
            {collapsed && databases.length > 0 && (
              <span className="ml-1 text-faint/70">{databases.length}</span>
            )}
          </Link>
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
                {/* #742 finding 04 — presentational only: reassigning a space's
                    group changes where it renders, never what it grants. */}
                {groups && groups.length > 0 && onMoveToGroup && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1 text-meta font-semibold uppercase tracking-wider text-faint">
                      Move to group
                    </div>
                    {groups.map((g) => (
                      <DropdownMenuItem
                        key={g.id}
                        disabled={space.groupId === g.id}
                        onSelect={() => onMoveToGroup(g.id)}
                      >
                        <LetterMark name={g.name} color={g.color} className="mr-2" />
                        {g.name}
                      </DropdownMenuItem>
                    ))}
                    {space.groupId && (
                      <DropdownMenuItem onSelect={() => onMoveToGroup(null)}>
                        Remove from group
                      </DropdownMenuItem>
                    )}
                  </>
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
                              // #618 — was "The trash cannot recover any of
                              // it", written before #37 shipped restore for
                              // spaces/databases. An admin CAN bring this
                              // back (Settings → Trash) within the same
                              // 30-day window every other trash already
                              // promises — verified live: restoring the
                              // space cascades every database in it back too.
                              message:
                                `This deletes ${count} database${count === 1 ? '' : 's'} ` +
                                `(${databases.map((d) => d.name).join(', ')}) and every record in them. ` +
                                `A workspace admin can restore the space (and everything in it) from ` +
                                `Settings → Trash for 30 days.`,
                              confirmLabel: 'Delete space',
                              danger: true,
                              // Typed name, matching what delete_database already
                              // demands for a strictly SMALLER action.
                              requireTyped: space.name,
                            }
                          : {
                              title: `Delete "${space.name}"?`,
                              // #618 — same correction: an empty space is
                              // still soft-deleted, not destroyed outright.
                              message:
                                'This space is empty. A workspace admin can restore it from Settings → Trash for 30 days.',
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
      </SidebarRow>
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
        /* #641 — a bare stack of rows here has ZERO gap between them (no
           flex-col wrapper existed), so pitch collapsed to exactly the row
           height: 25.5px, tighter than the top nav's own ~27.5px pitch. A
           nested row must never be denser than its parent, so this wrapper
           adds the SAME gap-0.5 the nav uses, matching its pitch instead of
           undercutting it. */
        <div className="flex flex-col gap-0.5">
        {/* #369 — ONE context for the whole space. Two sibling contexts (root
           databases, and one per folder) is why nothing could be dragged BETWEEN
           containers: dnd-kit cannot see across contexts, so a folder in another
           one was never a drop target. */}
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
              onCopyDocToPersonal={(id) => copyDocToPersonal.mutate(id)}
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
              viewsOnly={viewsOnly}
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
                      viewsOnly={viewsOnly}
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
                /* #380/#742 — a space-level dashboard is a SIBLING of the
                   databases, so it shares their left edge — depth 0 under the
                   new zero-indent model, same as every other space-root row. */
                depth={0}
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
              onCopyToPersonal={(id) => copyDocToPersonal.mutate(id)}
              setDialog={setDialog}
            />
          ))}
          <DragPreview>
            {itemDrag.activeId && (
              <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-[3px] text-body text-ink shadow-[var(--shadow-lifted)]">
                {itemLabel(itemDrag.activeId) ?? ''}
              </div>
            )}
          </DragPreview>
        </DndContext>
        </div>
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
  onCopyToPersonal,
  setDialog,
  // #742 — a space-root document is depth 0 now; a folder-nested one relies
  // on the folder body's own wrapper for the one real step, same reasoning
  // as DatabaseRow's default above.
  depth = 0,
  canEdit = true,
}: {
  ws: string;
  doc: { id: string; title: string; icon: string | null; folder_id: string | null };
  active: boolean;
  folders: FolderInfo[];
  onMove: (id: string, folderId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onCopyToPersonal: (id: string) => void;
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
        <EntityIcon icon={doc.icon} color={null} fallback={<FileText className="h-3.5 w-3.5 shrink-0 text-muted" />} className="text-body" />
        <span className="overflow-hidden whitespace-nowrap">{doc.title || 'Untitled'}</span>
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
            // #293 — "Copy to My Space": fork this shared document into an
            // independent personal copy, never sync'd back. #524 convention:
            // fires immediately, no dialog, no name prompt — same as Duplicate.
            label: 'Copy to My Space',
            separatorBefore: true,
            onSelect: () => onCopyToPersonal(doc.id),
          },
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
              className="w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-body text-ink outline-none focus:border-border-strong"
            />
          )}
          <div className="flex justify-end gap-2">
            <button className="rounded-[var(--radius-control)] px-3 py-1 text-body text-muted hover:bg-hover" onClick={onClose}>
              Cancel
            </button>
            <button
              className={cn(
                'rounded-[var(--radius-control)] px-3 py-1 text-body font-medium text-white',
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
  onCopyDocToPersonal,
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
  viewsOnly,
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
  onCopyDocToPersonal: (id: string) => void;
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
  /** #742 finding 05 — hide this folder's database rows; their views (below,
   *  unchanged) still render. */
  viewsOnly?: boolean;
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
      {/* #380/#742 — a folder sits on the SAME left edge as the databases
          beside it (founder's spec: "folders, dashboards — the same padding
          left as databases"), so it goes through the shared row at depth 0
          under the new zero-indent model — the folder's OWN body wrapper is
          what supplies the one real step for its children, not this row. */}
      {/* #383 — the header is a ROW, not a button.
          It used to be a single <button> wrapping everything, which is why it
          could never grow a menu: a <button> inside a <button> is invalid HTML
          and the inner one does not reliably receive clicks. The toggle is now
          the button and the menu is its sibling, so the folder gets the rename
          and delete every database row has had all along.

          #779 — this used to hand-replicate SidebarRow's gutter math (12px
          chevron + 2px margin) with a comment claiming it was "measured, not
          guessed." Re-measured live for this ticket: it WAS correct — but a
          second component whose alignment rests on a comment matching a
          constant it never references is the same risk one level down as
          the space header's bug, just not yet triggered. Migrated onto
          SidebarRow itself so the match is structural, not by agreement. */}
      <SidebarRow depth={0} className="text-ink-secondary hover:bg-hover" caret={
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
          aria-expanded={!collapsed}
          className="text-faint hover:text-muted"
        >
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        </button>
      }>
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <EntityIcon icon={folder.icon} color={null} fallback={<FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted" />} className="text-body" />
          <span className="overflow-hidden whitespace-nowrap">{folder.name}</span>
        </button>
        {contentCount > 0 && (
          <span className="ml-1 shrink-0 text-meta text-faint">{contentCount}</span>
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
      </SidebarRow>
      {!collapsed && (
        /* #380 — same guide line, same offset as a database's nested views.
           #641 — gap-0.5 added: same zero-gap-between-rows issue as the
           space's own root list, fixed the same way. */
        <div
          className="flex flex-col gap-0.5 border-l border-border-default"
          style={{ marginLeft: SIDEBAR_INDENT_PX[1] }}
        >
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
              <p className="text-label text-muted">Empty — drop something here</p>
              {canEdit && (
                <div className="flex flex-wrap items-center justify-center gap-1">
                  <button
                    type="button"
                    onClick={() => onNewDatabase(folder.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-label text-muted hover:bg-hover hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> Database
                  </button>
                  <button
                    type="button"
                    onClick={() => onNewDocument(folder.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-label text-muted hover:bg-hover hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> Document
                  </button>
                </div>
              )}
            </div>
          )}
          {/* #369 — no nested DndContext: the space owns the one context now. */}
          {/* #742 finding 05 — views-only mode hides these rows; their views
              (below) render regardless, unaffected by the toggle. */}
          {!viewsOnly && (
            <SortableContext items={databases.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                {databases.map((db) => (
                  <DatabaseRow
                    key={db.id}
                    ws={ws}
                    db={db}
                    active={pathname.startsWith(`/w/${ws}/d/${db.id}`)}
                    isAdmin={isAdmin}
                    folders={folders}
                    onMove={onMove}
                    reorderable={canEdit}
                  />
                ))}
            </SortableContext>
          )}
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
              /* #380/#368/#742 — the folder BODY wrapper (below) now supplies
                 the one real indent step itself (SIDEBAR_INDENT_PX[1]), so a
                 row inside it stays depth 0 — stacking another step here would
                 double the folder's own indent. */
              depth={0}
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
              onCopyToPersonal={onCopyDocToPersonal}
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
  viewsOnly,
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
  /** #742 finding 05 — hide the database's own row; its views (siblings
   *  since finding 06) still render below, unaffected. */
  viewsOnly?: boolean;
}) {
  const isHere = pathname.startsWith(`/w/${ws}/d/${db.id}`);

  return (
    <Fragment>
      {!viewsOnly && (
        <DatabaseRow
          ws={ws}
          db={db}
          active={isHere}
          isAdmin={isAdmin}
          folders={folders}
          onMove={onMove}
          reorderable={canEdit}
        />
      )}
      {/* #742 finding 06 — a database's own views render as FLAT SIBLINGS now,
          not behind an expand/collapse caret. No leaf row has children in the
          new model, so there is nothing left to expand: depth 0, same as the
          database beside it, no guide line (that implied nesting). */}
      {views.map((v) => (
        <SidebarViewRow
          key={v.id}
          ws={ws}
          view={v}
          active={isHere && currentViewId === v.id}
          folders={folders}
          onMove={onMoveView}
          onRename={onRenameView}
          onDelete={onDeleteView}
          canEdit={canEdit}
        />
      ))}
    </Fragment>
  );
}

function DatabaseRow({
  ws,
  db,
  active,
  isAdmin,
  folders = [],
  onMove,
  reorderable = false,
  expandable = false,
  expanded = false,
  onToggle,
  // #742 — the OLD geometry hardcoded depth 1 here, because every database
  // row (space-root or folder-nested) got the same single step and a folder
  // added a second one on top. Under the new zero-indent model a space-root
  // database is depth 0; a folder-nested one relies on the folder body's own
  // wrapper for the one real step, so it ALSO passes 0 here rather than
  // stacking a second indent on top of the folder's.
  depth = 0,
}: {
  ws: string;
  db: DatabaseSummary;
  active: boolean;
  isAdmin: boolean;
  folders?: FolderInfo[];
  onMove?: (dbId: string, folderId: string | null) => void;
  reorderable?: boolean;
  /** #382 — only true when there is something behind the caret. */
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  depth?: SidebarDepth;
}) {
  const mutations = useSidebarMutations(ws);
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /**
   * #752 — every content-mutating item below (rename/duplicate/description/
   * icon/import/sync/automations/move/delete) leads to a `PATCH`/`DELETE .../
   * databases/:db` or a database-scoped write that the API refuses below
   * `creator` on THIS database (`databases.controller.ts`'s `assertAccess`).
   * The menu used to gate on workspace `role !== 'guest'` — a workspace member
   * whose effective access on this particular database is only viewer through
   * editor saw every item, opened the dialog, and was refused on save. `db`
   * (the sidebar's own list row, `DatabaseSummary`) already carries `my_access`
   * — the identical batched `AccessService` computation the database page's
   * own `schemaEditable` reads from the detail query — so this reuses it
   * rather than re-deriving a second copy of the ladder.
   */
  const schemaEditable = atLeast(db.my_access ?? undefined, 'creator');
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
      depth={depth}
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
          <span className="overflow-hidden whitespace-nowrap">{db.name}</span>
        </Link>
        </>
      )}
      {!renaming && (
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
         *
         * #752 — no longer gated on the workspace-level `canEdit` (role !==
         * 'guest'): SidebarRowMenu itself renders nothing when every action is
         * hidden ("an all-hidden menu renders nothing rather than an empty
         * popover"), so per-item `hidden: !schemaEditable` below already
         * collapses to the old behaviour for a plain viewer/commenter/
         * contributor/editor on this database, and correctly OFFERS the menu
         * to a guest who holds a database-scoped creator grant — a real,
         * supported access shape this workspace-level boolean could never see.
         *
         * THE AUDIT (AC4) — every item below, the endpoint it leads to, and
         * what that endpoint actually requires (apps/api, `assertAccess`
         * unless noted):
         *   Rename                  PATCH  .../databases/:db            creator (per-db)
         *   Duplicate                POST  .../databases/:db/duplicate  creator (per-db, PacksService)
         *   Edit/Add description    PATCH  .../databases/:db            creator (per-db)
         *   Icon & color            PATCH  .../databases/:db            creator (per-db)
         *   Import CSV…              POST  .../databases/:db/import     creator (per-db)
         *   Sync from…          POST/PATCH/DELETE  .../sources[/:id]    creator (per-db)
         *   Buttons & automations     CRUD  .../databases/:db/automations   creator (per-db)
         *   Manage access             POST/DELETE  .../grants           admin (WORKSPACE-level, @MinRole) — already correct, unchanged
         *   Move to …                PATCH  .../databases/:db (folder_id)  creator (per-db) — same PATCH as Rename
         *   Hide from my sidebar     no API call — client-only localStorage — no gate needed
         *   Relations / Trash        navigation only — the destination page has its own gate
         *   Delete database        DELETE  .../databases/:db            creator (per-db)
         * Every content-mutating item needs `creator` on THIS database; only
         * "Manage access" needs workspace `admin` instead. Re-audit this list
         * before adding a new item rather than assuming it also needs `creator`.
         */
        <SidebarRowMenu
          label={db.name}
          contentClassName="w-56"
          actions={[
            { label: 'Rename', onSelect: () => setRenaming(true), hidden: !schemaEditable },
            {
              // #524 — fires immediately, no dialog and no name prompt, matching
              // the view/record duplicate precedent (view-tab.tsx) rather than
              // the typed-confirm pattern below: this isn't destructive, so
              // there's nothing to guard against.
              label: 'Duplicate',
              hidden: !schemaEditable,
              onSelect: () =>
                mutations.duplicateDatabase.mutate(
                  { id: db.id },
                  {
                    onError: () => toast.error('Could not duplicate the database'),
                    onSuccess: (result) => {
                      for (const name of result.skipped_relations) {
                        toast.info(`"${name}" was not carried over — it relates to a database outside this copy`);
                      }
                      for (const field of result.skipped_derived_fields) {
                        toast.info(`"${field.name}" was not carried over — ${field.reason}`);
                      }
                      toast.success(`Duplicated as "${result.name}"`);
                      router.push(`/w/${ws}/d/${result.id}`);
                    },
                  },
                ),
            },
            {
              label: db.description ? 'Edit description' : 'Add description',
              hidden: !schemaEditable,
              onSelect: () => setDescribing(true),
            },
            { label: 'Icon & color', onSelect: () => setIconing(true), hidden: !schemaEditable },
            { label: 'Import CSV…', onSelect: () => setImporting(true), hidden: !schemaEditable },
            { label: 'Sync from…', onSelect: () => setSyncing(true), hidden: !schemaEditable },
            { label: 'Buttons & automations', onSelect: () => setAutomating(true), hidden: !schemaEditable },
            // `hidden` rather than a conditional spread — see the note on
            // SidebarMenuAction. The item is declared in place and simply not
            // rendered, so it cannot be lost to a misplaced spread.
            { label: 'Manage access', onSelect: () => setSharing(true), hidden: !isAdmin },
            // "Move to" — the section header rides on the FIRST target, so the
            // heading cannot outlive the group it labels. Same `creator`
            // requirement as Rename etc. — a move is the same PATCH with a
            // different field.
            ...(schemaEditable && onMove && (folders.length > 0 || db.folderId)
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
            { label: 'Relations', href: `/w/${ws}/d/${db.id}/relations` },
            { label: 'Trash', href: `/w/${ws}/d/${db.id}/trash` },
            {
              label: 'Delete database',
              danger: true,
              hidden: !schemaEditable,
              onSelect: () => setConfirmingDelete(true),
            },
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
      className="w-full rounded border border-border-strong bg-card px-1 py-0.5 text-body text-ink"
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

/**
 * #742 finding 08 — "three marks, three jobs, no overlap": a coloured letter
 * mark is how a GROUP (and, per the same finding, a SPACE) is told apart from
 * a database's monochrome glyph or a view's per-type icon. First letter of
 * the name, uppercased; falls back to a neutral border-tinted grey when no
 * color is set rather than picking one, since an unset color is information
 * (nobody has customized this one yet), not a value to paper over.
 */
function LetterMark({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded text-micro font-semibold text-[var(--text-on-dark)]',
        className,
      )}
      style={{ backgroundColor: color ?? 'var(--text-faint)' }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function GroupHeaderRow({
  group,
  canEdit,
  onRename,
  onDelete,
}: {
  group: SpaceGroup;
  canEdit: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const confirmDialog = useConfirm();
  return (
    <>
      {/* #779 — the icon+label pair, gap-2 to match every other row's leaf
          content (DatabaseRow's Link uses the same gap) now that the
          surrounding row (`GroupDropZone`) owns the gutter/padding via
          SidebarRow instead of this component reserving its own. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <LetterMark name={group.name} color={group.color} />
        {renaming ? (
          <RenameInline initial={group.name} onDone={(v) => { if (v) onRename(v); setRenaming(false); }} />
        ) : (
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-meta font-semibold uppercase tracking-wider text-muted">
            {group.name}
          </span>
        )}
      </span>
      {canEdit && (
        <SidebarRowMenu
          label={group.name}
          actions={[
            { label: 'Rename', onSelect: () => setRenaming(true) },
            {
              label: 'Delete group',
              danger: true,
              onSelect: () => {
                void (async () => {
                  const ok = await confirmDialog({
                    title: `Delete "${group.name}"?`,
                    message: 'Its spaces are not deleted — they move back to the ungrouped list.',
                    confirmLabel: 'Delete group',
                    danger: true,
                  });
                  if (ok) onDelete();
                })();
              },
            },
          ]}
        />
      )}
    </>
  );
}

/**
 * #742 finding 10 — "the mode button wears the database glyph, struck
 * through when off." Read literally: OFF names the state being toggled
 * (databases), not whether the button itself has been pressed — so the
 * struck-through glyph is what views-only mode LOOKS like (databases are
 * off), and the plain glyph is the normal, everything-visible state. One
 * button that states which mode you're in, not a press/no-press pair.
 */
function ViewsOnlyModeButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? 'Showing views only — click to show databases too' : 'Show views only, hiding databases'}
      aria-pressed={active}
      className={cn(
        'relative rounded p-0.5 hover:bg-hover',
        active ? 'text-ink' : 'text-faint hover:text-muted',
      )}
    >
      <Database className="h-3.5 w-3.5" />
      {active && (
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-hidden
        >
          <span className="h-px w-4 rotate-45 bg-current" />
        </span>
      )}
    </button>
  );
}

function NewGroupButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          title="New group"
          className="rounded p-0.5 text-faint hover:bg-hover hover:text-muted"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent title="New group">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(name.trim());
            setName('');
            setOpen(false);
          }}
        >
          <Input autoFocus placeholder="e.g. Client Work" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary" size="sm">Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!name.trim()}>Create</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewSpaceButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="mt-1 flex w-full items-center gap-2 rounded px-2 py-[3px] text-body text-muted hover:bg-hover">
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
        <p className="text-body text-muted">
          This deletes the database, its fields, records, views, and any relations linking it to
          other databases. A workspace admin can restore it from Settings → Trash for 30 days.
          {/* #618 — was "This permanently deletes...", written before #37
              shipped restore_database. Verified live: a deleted database
              reappears, fields/records/views intact, via Settings → Trash. */}
          {' '}Type <span className="font-semibold text-ink">{name}</span> to confirm.
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
