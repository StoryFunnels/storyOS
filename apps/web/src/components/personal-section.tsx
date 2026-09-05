'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FileText, Lock, Plus, Table2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases, useSpaces } from '@/lib/queries';
import { useDatabase } from '@/components/table-view/use-table-data';
import { canGroupBoardBy } from '@/components/views/groupable-fields';
import { VIEW_ICON } from '@/components/views/view-tab';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SidebarRow } from '@/components/sidebar-row';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';

interface PersonalDoc {
  id: string;
  title: string;
  icon: string | null;
}

interface PersonalView {
  id: string;
  name: string;
  /** A view's `type` can be anything ViewKind allows (created via the MCP or a
   * future surface, not just this dialog's PERSONAL_VIEW_TYPES subset) — kept
   * as a plain string, with a fallback icon where it renders. */
  type: string;
  database_id: string;
  database_name: string | null;
}

/**
 * #292 (remainder) — v1 offers only view types that read as a personal LENS
 * on shared data with no extra setup. `form` (built to collect external
 * submissions) and `dashboard` (a space-level, multi-database surface —
 * `views.service.ts`'s own comment: a personal view still needs exactly one
 * databaseId) don't fit that framing, so they're left out here rather than
 * offered and confusing. Not a technical limit — #520's endpoint would accept
 * either.
 */
const PERSONAL_VIEW_TYPES = ['table', 'board', 'calendar', 'gallery', 'list', 'feed', 'timeline'] as const;

function usePersonalViews(ws: string) {
  return useQuery({
    queryKey: ['personal-views', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/views/personal', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: PersonalView[] }).data;
    },
    enabled: Boolean(ws),
  });
}

/**
 * #292 — the database picker + type grid for a new personal view. A personal
 * view is always a window onto a shared database (#520: it still needs a
 * databaseId, there's no database-less personal view type), so this is a
 * strict subset of `NewViewDialog` (page.tsx): same board/calendar/timeline
 * config rules, PERSONAL_VIEW_TYPES instead of the full type list, and a
 * database picker in front since there's no ambient `:db` route param here.
 *
 * Controlled (`open`/`onOpenChange`), not self-triggering: this dialog's only
 * caller opens it from inside a DropdownMenu item, and batch-bar.tsx's #479
 * fix is the reason why a nested trigger is wrong here — mounting a portalled
 * overlay synchronously from a menu interaction races the menu's own
 * FocusScope teardown, which sees focus land outside itself and dismisses the
 * new overlay in the same tick. `PersonalSection` defers the open by one tick
 * the same way #479 does, so this component just renders whatever `open` it's
 * given.
 */
function NewPersonalViewDialog({
  ws,
  open,
  onOpenChange,
  onCreate,
}: {
  ws: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (databaseId: string, name: string, type: string) => void;
}) {
  const [databaseId, setDatabaseId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof PERSONAL_VIEW_TYPES)[number]>('table');
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);
  const spaceName = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
  const bySpace = new Map<string, NonNullable<typeof databases.data>>();
  for (const d of databases.data ?? []) {
    const list = bySpace.get(d.spaceId) ?? [];
    list.push(d);
    bySpace.set(d.spaceId, list);
  }
  const target = useDatabase(ws, databaseId);
  const boardGroupFields = (target.data?.fields ?? []).filter(canGroupBoardBy);
  const dateFields = (target.data?.fields ?? []).filter((f) => f.type === 'date' || f.type === 'created_at' || f.type === 'updated_at');

  function reset() {
    setDatabaseId('');
    setName('');
    setType('table');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent title="New personal view">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const finalName = name.trim() || type[0]!.toUpperCase() + type.slice(1);
            onCreate(databaseId, finalName, type);
            onOpenChange(false);
            reset();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label>Database</Label>
            <select
              className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={databaseId}
              onChange={(e) => setDatabaseId(e.target.value)}
              autoFocus
            >
              <option value="" disabled>
                Choose a database…
              </option>
              {[...bySpace.entries()].map(([spaceId, dbs]) => (
                <optgroup key={spaceId} label={spaceName.get(spaceId) ?? 'Space'}>
                  {dbs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {databaseId && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="personal-view-name">Name</Label>
                <Input
                  id="personal-view-name"
                  placeholder={type[0]!.toUpperCase() + type.slice(1)}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Type</Label>
                <div className="grid grid-cols-2 gap-2">
                  {PERSONAL_VIEW_TYPES.map((kind) => {
                    const Icon = VIEW_ICON[kind];
                    const need =
                      kind === 'board' && boardGroupFields.length === 0
                        ? 'Needs a select, user, or one-to-many relation field'
                        : (kind === 'calendar' || kind === 'timeline') && dateFields.length === 0
                          ? 'Needs a date field'
                          : null;
                    return (
                      <button
                        key={kind}
                        type="button"
                        disabled={Boolean(need)}
                        title={need ?? undefined}
                        onClick={() => setType(kind)}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
                          type === kind ? 'border-accent bg-accent-soft text-ink' : 'border-border-default text-ink-secondary hover:bg-hover'
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {kind[0]!.toUpperCase() + kind.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!databaseId}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * #292/#520 — get-or-create the caller's personal space. The endpoint is
 * idempotent (a unique index on (workspace_id, owner_user_id) WHERE personal
 * backs it), so calling it as a plain query on every sidebar mount is safe —
 * there is no separate "does my personal space exist" check to make first.
 */
export function usePersonalSpace(ws: string) {
  return useQuery({
    queryKey: ['personal-space', ws],
    queryFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/personal', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { id: string; name: string };
    },
    // The row's id/shape never changes once created for this user+workspace.
    staleTime: Infinity,
  });
}

/**
 * #292 — a dedicated Personal section, separate from the shared Spaces tree
 * (docs/architecture/personal-space.md: it "isn't just another space in the
 * list" — it can't be shared, moved, or deleted like one). Documents AND
 * personal views (#520/#551), per #290's v1 scope: exactly those two, never
 * a private database.
 */
export function PersonalSection({ ws }: { ws: string }) {
  const personal = usePersonalSpace(ws);
  const spaceId = personal.data?.id;
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();

  const docsKey = ['space-docs', ws, spaceId] as const;
  const docs = useQuery({
    queryKey: docsKey,
    enabled: Boolean(spaceId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId! } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: PersonalDoc[] }).data;
    },
  });
  const views = usePersonalViews(ws);
  const viewsKey = ['personal-views', ws] as const;

  const createDoc = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId! } },
        body: { title: 'Untitled' } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: docsKey });
      router.push(`/w/${ws}/doc/${d.id}`);
    },
    onError: () => toast.error('Could not create document'),
  });

  const deleteDoc = useMutation({
    mutationFn: async (docId: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc: docId } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: docsKey }),
    onError: () => toast.error('Could not delete document'),
  });

  const createView = useMutation({
    mutationFn: async ({ databaseId, name, type }: { databaseId: string; name: string; type: string }) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/views/personal', {
        params: { path: { ws, db: databaseId } },
        body: { name, type, config: {} } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
    onError: () => toast.error('Could not create view'),
  });

  const deleteView = useMutation({
    mutationFn: async (v: PersonalView) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db: v.database_id, view: v.id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
    // #292 build-time finding, filed as a follow-up: deleting a view requires
    // editor on the DATABASE (views.controller.ts's assertDb), but creating a
    // personal view over it only ever required viewer (#520). A viewer-only
    // member can hit this 403 deleting their OWN personal view — the toast
    // surfaces it honestly rather than pretending it always works.
    onError: () => toast.error('Could not delete view — you may need editor access to this database'),
  });

  const docItems = docs.data ?? [];
  const viewItems = views.data ?? [];
  const isEmpty = docItems.length === 0 && viewItems.length === 0;
  const canCreateDoc = Boolean(spaceId) && !createDoc.isPending;

  /** batch-bar.tsx's #479 fix, same shape: a macrotask after the DropdownMenu
   * item's onSelect, so the new Dialog mounts after the menu's FocusScope has
   * finished tearing down instead of racing it. */
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [pendingViewDialog, setPendingViewDialog] = useState(false);
  useEffect(() => {
    if (!pendingViewDialog) return;
    const t = setTimeout(() => {
      setViewDialogOpen(true);
      setPendingViewDialog(false);
    }, 0);
    return () => clearTimeout(t);
  }, [pendingViewDialog]);

  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Personal</span>
        {!isEmpty && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="New…"
                className="rounded p-0.5 text-faint hover:bg-hover hover:text-muted"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={!canCreateDoc} onSelect={() => createDoc.mutate()}>
                <FileText className="mr-2 h-3.5 w-3.5" /> New document
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPendingViewDialog(true)}>
                <Table2 className="mr-2 h-3.5 w-3.5" /> New view…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/*
        #292 / docs/architecture/personal-space.md §1 — "say so at the point of
        use", verbatim. The ADR calls a wording drift here a support incident,
        so this sentence must change in the same PR as the ADR if it ever needs
        to change at all, not independently.
      */}
      <p className="mb-1.5 flex items-start gap-1 px-2 text-[11px] leading-snug text-faint">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Only you can see this. If your account is removed, this content is deleted with it.</span>
      </p>
      {isEmpty ? (
        <div className="px-2 pb-1">
          <p className="mb-1.5 text-[12px] text-muted">Nothing here yet — draft a doc or a view only you can see.</p>
          <div className="flex flex-col items-start gap-1">
            <button
              type="button"
              onClick={() => createDoc.mutate()}
              disabled={!canCreateDoc}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> New document
            </button>
            <button
              type="button"
              onClick={() => setViewDialogOpen(true)}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
            >
              <Table2 className="h-3.5 w-3.5" /> New view…
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {docItems.map((doc) => (
            <SidebarRow key={doc.id} depth={1}>
              <Link href={`/w/${ws}/doc/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-ink-secondary">
                <FileText className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="truncate">{doc.title || 'Untitled'}</span>
              </Link>
              <SidebarRowMenu
                label={doc.title || 'Untitled'}
                actions={[
                  {
                    label: 'Delete',
                    danger: true,
                    onSelect: async () => {
                      const ok = await confirm({
                        title: `Delete "${doc.title || 'Untitled'}"?`,
                        confirmLabel: 'Delete',
                        danger: true,
                      });
                      if (ok) deleteDoc.mutate(doc.id);
                    },
                  },
                ]}
              />
            </SidebarRow>
          ))}
          {viewItems.map((v) => {
            const Icon = VIEW_ICON[v.type as keyof typeof VIEW_ICON] ?? Table2;
            return (
              <SidebarRow key={v.id} depth={1}>
                <Link
                  href={`/w/${ws}/d/${v.database_id}?view=${v.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2 text-ink-secondary"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="truncate">{v.name}</span>
                  {v.database_name && <span className="shrink-0 truncate text-[11px] text-faint">· {v.database_name}</span>}
                </Link>
                <SidebarRowMenu
                  label={v.name}
                  actions={[
                    {
                      label: 'Delete',
                      danger: true,
                      onSelect: async () => {
                        const ok = await confirm({
                          title: `Delete "${v.name}"?`,
                          confirmLabel: 'Delete',
                          danger: true,
                        });
                        if (ok) deleteView.mutate(v);
                      },
                    },
                  ]}
                />
              </SidebarRow>
            );
          })}
        </div>
      )}
      <NewPersonalViewDialog
        ws={ws}
        open={viewDialogOpen}
        onOpenChange={setViewDialogOpen}
        onCreate={(databaseId, name, type) => createView.mutate({ databaseId, name, type })}
      />
    </div>
  );
}
