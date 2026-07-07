'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Database, MoreHorizontal, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth-client';
import { useDatabases, useSidebarMutations, useSpaces, useWorkspace } from '@/lib/queries';
import type { DatabaseSummary, Space } from '@/lib/queries';
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
      <div className="flex h-12 items-center gap-2 border-b border-border-default px-4">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-[11px] font-bold text-[var(--text-on-dark)]">
          {workspace.data?.name?.[0]?.toUpperCase() ?? 'S'}
        </div>
        <span className="truncate text-sm font-semibold text-ink">{workspace.data?.name ?? '…'}</span>
      </div>

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
              />
            ))}
          </SortableContext>
        </DndContext>

        {canEdit && <NewSpaceButton onCreate={(name) => mutations.createSpace.mutate({ name })} />}
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

function SpaceSection({
  ws,
  space,
  databases,
  canEdit,
}: {
  ws: string;
  space: Space;
  databases: DatabaseSummary[];
  canEdit: boolean;
}) {
  const pathname = usePathname();
  const mutations = useSidebarMutations(ws);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: space.id });
  const [renaming, setRenaming] = useState(false);
  const [newDbOpen, setNewDbOpen] = useState(false);

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
                    { onError: () => toast.error('Could not create database') },
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

      {databases.map((db) => (
        <DatabaseRow
          key={db.id}
          ws={ws}
          db={db}
          active={pathname.startsWith(`/w/${ws}/d/${db.id}`)}
          canEdit={canEdit}
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
}: {
  ws: string;
  db: DatabaseSummary;
  active: boolean;
  canEdit: boolean;
}) {
  const mutations = useSidebarMutations(ws);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
            <DropdownMenuItem asChild>
              <Link href={`/w/${ws}/d/${db.id}/trash`}>Trash</Link>
            </DropdownMenuItem>
            <DropdownMenuItem className="text-error" onSelect={() => setConfirmingDelete(true)}>
              Delete database
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DeleteDatabaseDialog
          name={db.name}
          onConfirm={(typed) => {
            mutations.deleteDatabase.mutate(
              { id: db.id, confirm: typed },
              {
                onError: () => toast.error('Name does not match'),
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
          This permanently deletes the database, its fields, records, and views. Type{' '}
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
