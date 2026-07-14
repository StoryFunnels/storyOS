'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Database, FileText, Folder as FolderIcon, Home, Inbox, KeyRound, LayoutTemplate, MoreHorizontal, Plug, Plus, Search, Settings, Star, UserRound } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { AutomationsPanel } from '@/components/automations-panel';
import { ImportWizard } from '@/components/import-wizard';
import { InboxPanel, useUnreadCount } from '@/components/inbox-panel';
import { openPalette } from '@/lib/shortcuts';
import { useDatabases, useSidebarMutations, useSpaces, useWorkspace } from '@/lib/queries';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { ShareDialog } from '@/components/share-dialog';
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { TemplateGalleryDialog } from '@/components/template-gallery';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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

export function Sidebar() {
  const params = useParams<{ ws: string }>();
  const ws = params.ws;
  const workspace = useWorkspace(ws);
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const mutations = useSidebarMutations(ws);
  const router = useRouter();

  const canEdit = workspace.data?.role !== 'guest';
  const isAdmin = workspace.data?.role === 'admin';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const unread = useUnreadCount(ws);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onSpaceDragEnd(event: DragEndEvent) {
    const list = spaces.data ?? [];
    const from = list.findIndex((s) => s.id === event.active.id);
    const to = list.findIndex((s) => s.id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    mutations.updateSpace.mutate({ id: String(event.active.id), position: list[to]!.position });
    mutations.updateSpace.mutate({ id: list[to]!.id, position: list[from]!.position });
  }

  return (
    <aside className="sticky top-0 flex h-screen w-60 flex-col border-r border-border-default bg-sidebar">
      <div className="shrink-0">
        <WorkspaceSwitcher ws={ws} currentName={workspace.data?.name} />
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
          <span className="ml-auto text-[10px] text-faint">⌘K</span>
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSpaceDragEnd}>
          <SortableContext
            items={(spaces.data ?? []).map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            {(spaces.data ?? []).map((space) => (
              <SpaceSection
                key={space.id}
                ws={ws}
                space={space}
                databases={(databases.data ?? []).filter((d) => d.spaceId === space.id)}
                canEdit={canEdit}
                isAdmin={isAdmin}
              />
            ))}
          </SortableContext>
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
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={async () => {
            await authClient.signOut();
            router.replace('/login');
          }}
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
  const pathname = usePathname();
  const router = useRouter();
  const mutations = useSidebarMutations(ws);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: space.id });
  const [renaming, setRenaming] = useState(false);
  const [newDbOpen, setNewDbOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [iconing, setIconing] = useState(false);

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
      return (data as unknown as { data: Array<{ id: string; title: string; icon: string | null }> }).data;
    },
  });
  const createDoc = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: space.id } },
        body: { title: 'Untitled' } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
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
  const [dialog, setDialog] = useState<
    | null
    | { kind: 'name'; title: string; value: string; submit: (v: string) => void }
    | { kind: 'confirm'; title: string; danger?: boolean; submit: () => void }
  >(null);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="mb-1"
    >
      <div
        className="group flex items-center justify-between px-2 py-1"
        {...attributes}
        {...listeners}
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
          <button
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wider text-faint hover:text-muted"
            onClick={toggleCollapsed}
            onPointerDown={(e) => e.stopPropagation()}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronRight
              className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
            />
            {space.icon && <span className="text-[13px] leading-none">{space.icon}</span>}
            <span className="truncate">{space.name}</span>
            {collapsed && databases.length > 0 && (
              <span className="ml-1 text-faint/70">{databases.length}</span>
            )}
          </button>
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
                <DropdownMenuItem onSelect={() => setNewDbOpen(true)}>
                  <Database className="mr-2 h-3.5 w-3.5" /> New database
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => createDoc.mutate()}>
                  <FileText className="mr-2 h-3.5 w-3.5" /> New document
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
            <Dialog open={newDbOpen} onOpenChange={setNewDbOpen}>
              <NewDatabaseDialog
                onCreate={(name) => {
                  mutations.createDatabase.mutate(
                    { space_id: space.id, name },
                    {
                      onError: () => toast.error('Could not create database'),
                      onSuccess: (created) => router.push(`/w/${ws}/d/${created.id}`),
                    },
                  );
                  setNewDbOpen(false);
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
                <DropdownMenuItem onSelect={() => setIconing(true)}>Icon & color</DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem onSelect={() => setSharing(true)}>Manage access</DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-error"
                  onSelect={() => {
                    if (databases.length > 0) {
                      toast.error('Move or delete its databases first');
                      return;
                    }
                    mutations.deleteSpace.mutate(space.id);
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
        <>
          {folders.map((folder) => (
            <FolderSection
              key={folder.id}
              ws={ws}
              folder={folder}
              databases={databases.filter((d) => d.folderId === folder.id)}
              folders={folders}
              onMove={moveToFolder}
              pathname={pathname}
              canEdit={canEdit}
              isAdmin={isAdmin}
            />
          ))}
          {databases
            .filter((db) => !db.folderId)
            .map((db) => (
              <DatabaseRow
                key={db.id}
                ws={ws}
                db={db}
                active={pathname.startsWith(`/w/${ws}/d/${db.id}`)}
                canEdit={canEdit}
                isAdmin={isAdmin}
                folders={folders}
                onMove={moveToFolder}
              />
            ))}
          {(docs.data ?? []).map((d) => (
            <div key={d.id} className="group/doc relative flex items-center">
              <Link
                href={`/w/${ws}/doc/${d.id}`}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-[3px] text-[13px] hover:bg-hover',
                  pathname === `/w/${ws}/doc/${d.id}` ? 'bg-active font-medium text-ink' : 'text-ink-secondary',
                )}
              >
                {d.icon ? <span className="text-[13px] leading-none">{d.icon}</span> : <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />}
                <span className="truncate">{d.title || 'Untitled'}</span>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="absolute right-1 rounded p-0.5 text-muted opacity-0 hover:bg-active hover:text-ink group-hover/doc:opacity-100">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setDialog({ kind: 'name', title: 'Rename document', value: d.title || '', submit: (v) => renameDoc.mutate({ id: d.id, title: v }) })}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-error"
                    onSelect={() => setDialog({ kind: 'confirm', title: `Delete "${d.title || 'Untitled'}"?`, danger: true, submit: () => deleteDoc.mutate(d.id) })}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </>
      )}
      {dialog && <PromptDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
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
  folders,
  onMove,
  pathname,
  canEdit,
  isAdmin,
}: {
  ws: string;
  folder: FolderInfo;
  databases: DatabaseSummary[];
  folders: FolderInfo[];
  onMove: (dbId: string, folderId: string | null) => void;
  pathname: string;
  canEdit: boolean;
  isAdmin: boolean;
}) {
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
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-1 rounded px-2 py-[3px] text-[13px] text-ink-secondary hover:bg-hover"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-faint transition-transform', !collapsed && 'rotate-90')} />
        {folder.icon ? <span className="text-[13px] leading-none">{folder.icon}</span> : <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted" />}
        <span className="truncate">{folder.name}</span>
        {databases.length > 0 && <span className="ml-auto text-[11px] text-faint">{databases.length}</span>}
      </button>
      {!collapsed && (
        <div className="ml-3 border-l border-border-default pl-1">
          {databases.length === 0 && <p className="px-2 py-1 text-[12px] text-faint">Empty</p>}
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
            />
          ))}
        </div>
      )}
    </div>
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
}: {
  ws: string;
  db: DatabaseSummary;
  active: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  folders?: FolderInfo[];
  onMove?: (dbId: string, folderId: string | null) => void;
}) {
  const mutations = useSidebarMutations(ws);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [iconing, setIconing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [automating, setAutomating] = useState(false);

  return (
    <div
      className={cn(
        'group flex items-center justify-between rounded px-2 py-[3px] text-[13px]',
        active
          ? 'bg-active text-ink shadow-[inset_2px_0_0_var(--accent)]'
          : 'text-ink-secondary hover:bg-hover',
      )}
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
        <Link href={`/w/${ws}/d/${db.id}`} className="flex min-w-0 flex-1 items-center gap-2">
          <EntityIcon
            icon={db.icon}
            color={db.color}
            fallback={<Database className="h-3.5 w-3.5 text-muted" />}
          />
          <span className="truncate">{db.name}</span>
        </Link>
      )}
      {canEdit && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded p-0.5 text-muted opacity-0 hover:bg-active group-hover:opacity-100">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setIconing(true)}>Icon & color</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setImporting(true)}>Import CSV…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setAutomating(true)}>Buttons & automations</DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem onSelect={() => setSharing(true)}>Manage access</DropdownMenuItem>
            )}
            {onMove && (folders.length > 0 || db.folderId) && (
              <>
                <DropdownMenuSeparator />
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Move to</div>
                {db.folderId && (
                  <DropdownMenuItem onSelect={() => onMove(db.id, null)}>↑ Space root</DropdownMenuItem>
                )}
                {folders
                  .filter((f) => f.id !== db.folderId)
                  .map((f) => (
                    <DropdownMenuItem key={f.id} onSelect={() => onMove(db.id, f.id)}>
                      <FolderIcon className="mr-2 h-3.5 w-3.5" /> {f.name}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/d/${db.id}/trash`}>Trash</Link>
            </DropdownMenuItem>
            <DropdownMenuItem className="text-error" onSelect={() => setConfirmingDelete(true)}>
              Delete database
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={sharing} onOpenChange={setSharing}>
        {sharing && <ShareDialog ws={ws} scope={{ database_id: db.id }} scopeName={db.name} />}
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
    </div>
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
