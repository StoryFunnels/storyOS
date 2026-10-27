'use client';
import { Tooltip } from '@/components/ui/tooltip';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Plus, Table2, UserRound } from 'lucide-react';
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
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CARET_HIT_AREA, PHONE_TAP } from '@/components/sidebar-row-style';
import { PERSONAL_PRIVACY_SENTENCE } from '@/lib/personal-space-copy';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GlyphSlot, SidebarRow } from '@/components/sidebar-row';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';
import { markNewDocument } from '@/lib/new-doc-focus';

export interface PersonalDoc {
  id: string;
  title: string;
  icon: string | null;
}

export interface PersonalView {
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

const PERSONAL_OPEN_KEY = 'storyos-personal-open';

export function usePersonalViews(ws: string) {
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

/** The personal space's documents: the same query (same key) the sidebar section runs, so the Personal page and the tree cannot disagree. */
export function usePersonalDocs(ws: string, spaceId: string | undefined) {
  return useQuery({
    queryKey: ['space-docs', ws, spaceId] as const,
    enabled: Boolean(spaceId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId! } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: PersonalDoc[] }).data;
    },
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
export function NewPersonalViewDialog({
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
      <DialogContent title="New personal view" unsaved>
        {/* #1097 — the privacy sentence, word for word, at the point of use (personal-space.md §1). */}
        <p className="mb-3 text-label text-muted" data-testid="personal-privacy">
          {PERSONAL_PRIVACY_SENTENCE}
        </p>
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
            <Select
              size="sm"
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
            </Select>
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
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-body disabled:cursor-not-allowed disabled:opacity-40 ${
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
  // #293 — destination list for "Move to shared space": every space that
  // ISN'T personal. Filters client-side off the same `useSpaces` response the
  // rest of the sidebar already fetches — the field was always on the wire
  // (schema.ts's `spaces.personal`), the `Space` type just didn't declare it.
  const sharedSpaces = (useSpaces(ws).data ?? []).filter((s) => !s.personal);

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
      markNewDocument(d.id);
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

  /**
   * #293 — publish a personal document to a shared space. One-way
   * (personal-space.md): once moved, coming back is a fresh "Copy to My
   * Space" from the shared side, never this in reverse. Fires immediately on
   * picking the target space, no confirmation dialog — the #524 convention
   * for a non-destructive sidebar action, same as duplicate.
   */
  const moveDocToSpace = useMutation({
    mutationFn: async ({ docId, targetSpaceId }: { docId: string; targetSpaceId: string }) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/documents/{doc}/move', {
        params: { path: { ws, doc: docId } },
        body: { space_id: targetSpaceId } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      // #293 — the doc leaves THIS space's list and lands in the target
      // space's OWN ['space-docs', ws, targetSpaceId] query (sidebar.tsx's
      // SpaceSection), which this component doesn't hold a key for. A prefix
      // invalidation on ['space-docs', ws] catches both sides in one call —
      // same fix copyDocToPersonal needed in sidebar.tsx for the same reason.
      void qc.invalidateQueries({ queryKey: ['space-docs', ws] });
      toast.success('Moved to shared space');
    },
    onError: () => toast.error('Could not move document'),
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
    // #1090 — open what was just made, the same rule as New document: a personal view is a lens on its database, so
    // it opens there with itself selected.
    onSuccess: (v, vars) => {
      void qc.invalidateQueries({ queryKey: viewsKey });
      router.push(`/w/${ws}/d/${vars.databaseId}?view=${v.id}`);
    },
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

  /** #293 — publish a personal view: it becomes an ordinary shared view on
   * its same database, visible to everyone with access. One-way, same as
   * moveDocToSpace above — the way back is copy_view_to_personal_space from
   * the shared side. No destination picker: unlike a document, a view's
   * database (and therefore its space) never changes, publishing only clears
   * who owns it. */
  const publishView = useMutation({
    mutationFn: async (v: PersonalView) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/publish', {
        params: { path: { ws, db: v.database_id, view: v.id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: (_data, v) => {
      void qc.invalidateQueries({ queryKey: viewsKey });
      // #293 — the view leaves this personal list and lands in its DATABASE's
      // own view-tab bar, which use-view-state.ts's useViewMutations reads
      // from ['database', ws, databaseId] — a query this component doesn't
      // otherwise touch. Same class of gap moveDocToSpace had for its
      // destination space's doc list.
      void qc.invalidateQueries({ queryKey: ['database', ws, v.database_id] });
      toast.success('Published to shared views');
    },
    onError: () => toast.error('Could not publish view — you may need editor access to this database'),
  });

  const docItems = docs.data ?? [];
  const viewItems = views.data ?? [];
  const isEmpty = docItems.length === 0 && viewItems.length === 0;
  const canCreateDoc = Boolean(spaceId) && !createDoc.isPending;

  /** batch-bar.tsx's #479 fix, same shape: a macrotask after the DropdownMenu
   * item's onSelect, so the new Dialog mounts after the menu's FocusScope has
   * finished tearing down instead of racing it. */
  // #1097 — the row's caret collapses the items; remembered per browser, never required (storage can be blocked).
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(PERSONAL_OPEN_KEY) === '0') setOpen(false);
    } catch {
      /* storage unavailable: stay open */
    }
  }, []);
  const toggleOpen = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(PERSONAL_OPEN_KEY, o ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !o;
    });
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

  const newMenu = (
    <DropdownMenu>
      <Tooltip label="New">
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="New in Personal" className={cn('rounded p-0.5 text-faint hover:bg-hover hover:text-muted', PHONE_TAP)}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled={!canCreateDoc} onSelect={() => createDoc.mutate()}>
          <FileText className="mr-2 h-3.5 w-3.5" /> New document
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPendingViewDialog(true)}>
          <Table2 className="mr-2 h-3.5 w-3.5" /> New view…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const newViewDialog = (
    <NewPersonalViewDialog
      ws={ws}
      open={viewDialogOpen}
      onOpenChange={setViewDialogOpen}
      onCreate={(databaseId, name, type) => createView.mutate({ databaseId, name, type })}
    />
  );

  /**
   * #1097 — ONE look, empty or not. Before, an empty Personal was #967's compact "Personal · only you" row and the first item
   * turned it into an older block (an uppercase PERSONAL header plus a standing two-line privacy paragraph), so adding a
   * document changed the section's whole shape. Now it is always Dara's #932 prototype row: a caret, the person glyph,
   * "Personal · only you", + New; the items nest under it like a space's contents, and the caret collapses them. The caret
   * slot is reserved even with nothing to collapse, so the row is the same size and the same place either way.
   *
   * The privacy sentence (personal-space.md §1, word for word: `PERSONAL_PRIVACY_SENTENCE`) is no longer a paragraph in the
   * sidebar. It sits at the points of use: this row's tooltip, the create dialog for a personal view, and the Personal page
   * header. The glyph is the person, not a lock: since #924 a lock in the sidebar means RESTRICTED.
   */
  const hasItems = !isEmpty;
  return (
    // #641 — mb-1 keeps a real section break above the Spaces tree.
    <div className="mb-1">
      <SidebarRow
        depth={0}
        className="hover:bg-hover"
        title={PERSONAL_PRIVACY_SENTENCE}
        caret={
          hasItems ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? 'Hide personal items' : 'Show personal items'}
              onClick={toggleOpen}
              className={cn('rounded text-faint hover:text-ink', CARET_HIT_AREA)}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden />
            </button>
          ) : undefined
        }
      >
        {/* The name opens the Personal page (#1097), like a space's name opens its page. */}
        <Link href={`/w/${ws}/personal`} className="flex min-w-0 flex-1 items-center gap-2 text-body text-ink-secondary">
          <GlyphSlot>
            <UserRound className="h-3.5 w-3.5 text-faint" />
          </GlyphSlot>
          Personal
          {/* #967 — "Personal · only you": the row states the privacy rule itself. */}
          <span className="text-muted">· only you</span>
        </Link>
        {newMenu}
      </SidebarRow>
      {open && hasItems && (
      <div className="flex flex-col gap-0.5">
        {docItems.map((doc) => (
          <SidebarRow key={doc.id} depth={1}>
            <Link href={`/w/${ws}/doc/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-ink-secondary">
              <FileText className="h-3.5 w-3.5 shrink-0 text-faint" />
              <span className="overflow-hidden whitespace-nowrap">{doc.title || 'Untitled'}</span>
            </Link>
            <SidebarRowMenu
              label={doc.title || 'Untitled'}
              actions={[
                ...sharedSpaces.map((s, i) => ({
                  label: s.name,
                  ...(i === 0 ? { sectionLabel: 'Move to shared space', separatorBefore: true } : {}),
                  // #768 — this is a one-way, visibility-changing move: the
                  // reverse ("Copy to My Space") is a fork with no sync back,
                  // not an undo. That's a different risk class from Delete
                  // right below (which already confirms) or Copy (which
                  // doesn't need to — it can't leak anything), so this gets
                  // the same confirm() gate, worded per the ADR verbatim
                  // (docs/architecture/personal-space.md).
                  onSelect: async () => {
                    const ok = await confirm({
                      title: `Move "${doc.title || 'Untitled'}" to ${s.name}?`,
                      message: "This will be visible to the workspace — you can copy it back later, but it won't stay in sync.",
                      confirmLabel: 'Move',
                    });
                    if (ok) moveDocToSpace.mutate({ docId: doc.id, targetSpaceId: s.id });
                  },
                })),
                {
                  label: 'Delete',
                  danger: true,
                  separatorBefore: true,
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
                <GlyphSlot>
                  <Icon className="h-3.5 w-3.5 text-faint" />
                </GlyphSlot>
                <span className="overflow-hidden whitespace-nowrap">{v.name}</span>
                {v.database_name && <span className="shrink-0 overflow-hidden whitespace-nowrap text-meta text-muted">· {v.database_name}</span>}
              </Link>
              <SidebarRowMenu
                label={v.name}
                actions={[
                  {
                    label: 'Publish to shared views',
                    onSelect: () => publishView.mutate(v),
                  },
                  {
                    label: 'Delete',
                    danger: true,
                    separatorBefore: true,
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
      {newViewDialog}
    </div>
  );
}
