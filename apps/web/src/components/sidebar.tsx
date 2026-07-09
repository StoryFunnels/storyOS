'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, ChevronsUpDown, Database, KeyRound, LayoutTemplate, MoreHorizontal, Plus, Settings } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useDatabases, useSidebarMutations, useSpaces, useWorkspace } from '@/lib/queries';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { ShareDialog } from '@/components/share-dialog';
import { TemplateGalleryDialog } from '@/components/template-gallery';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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
    <aside className="flex w-60 flex-col border-r border-border-default bg-sidebar">
      <WorkspaceSwitcher ws={ws} currentName={workspace.data?.name} />

      <nav className="flex-1 overflow-y-auto p-2">
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
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-[13px] text-muted hover:bg-hover"
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

      <div className="flex flex-col gap-0.5 border-t border-border-default p-2">
        {isAdmin && (
          <Link
            href={`/w/${ws}/settings/members`}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-hover"
          >
            <Settings className="h-3.5 w-3.5" /> Settings & members
          </Link>
        )}
        {canEdit && (
          <Link
            href={`/w/${ws}/settings/api`}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-hover"
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
        <button className="flex h-12 w-full items-center gap-2 border-b border-border-default px-4 text-left hover:bg-hover">
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

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="mb-3"
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
          <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
            {space.name}
          </span>
        )}
        {canEdit && (
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <Dialog open={newDbOpen} onOpenChange={setNewDbOpen}>
              <DialogTrigger asChild>
                <button className="rounded p-0.5 text-muted hover:bg-active" title="New database">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </DialogTrigger>
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

      {databases.map((db) => (
        <DatabaseRow
          key={db.id}
          ws={ws}
          db={db}
          active={pathname.startsWith(`/w/${ws}/d/${db.id}`)}
          canEdit={canEdit}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}

function DatabaseRow({
  ws,
  db,
  active,
  canEdit,
  isAdmin,
}: {
  ws: string;
  db: DatabaseSummary;
  active: boolean;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const mutations = useSidebarMutations(ws);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);

  return (
    <div
      className={cn(
        'group flex items-center justify-between rounded px-2 py-1 text-[13px]',
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
          <Database className="h-3.5 w-3.5 shrink-0 text-muted" />
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
            {isAdmin && (
              <DropdownMenuItem onSelect={() => setSharing(true)}>Manage access</DropdownMenuItem>
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
        <button className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-[13px] text-muted hover:bg-hover">
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
          onConfirm(typed);
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
