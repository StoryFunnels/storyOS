'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Database, FileText, Package, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useSidebarMutations } from '@/lib/queries';
import { markNewDocument } from '@/lib/new-doc-focus';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewDatabaseDialog } from '@/components/sidebar';
import { PACK_FILTERS, useRegistry, type RegistryCard } from '@/components/pack-install-dialog';
import { packCountsLine, registryVertical } from '@/components/pack-visual';
import { PackMap } from '@/components/pack-review';
import { cn } from '@/lib/utils';
import { ALL_PACKS, FEATURED_SPACE_PACKS, spacePackFilters, visibleSpacePacks } from '@/lib/space-start';

/**
 * Everything the space page needs to ADD something to the space it is showing (#1094): a database, a document, or a pack.
 *
 * These go through the same two calls the sidebar's "+" menu makes (`POST /databases`, `POST /spaces/:space/documents`) and
 * land the person on what they made, so the page's creators and the sidebar's cannot disagree about what "New database" does.
 */
export function useSpaceCreators(ws: string, spaceId: string) {
  const router = useRouter();
  const qc = useQueryClient();
  const mutations = useSidebarMutations(ws);
  const [databaseOpen, setDatabaseOpen] = useState(false);

  const createDocument = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId } },
        body: { title: 'Untitled' } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['space-docs', ws, spaceId] });
      markNewDocument(d.id);
      router.push(`/w/${ws}/doc/${d.id}`);
    },
    onError: () => toast.error('Could not create document'),
  });

  const dialog: ReactNode = (
    <Dialog open={databaseOpen} onOpenChange={setDatabaseOpen}>
      <NewDatabaseDialog
        onCreate={(name) => {
          mutations.createDatabase.mutate(
            { space_id: spaceId, name },
            {
              onError: () => toast.error('Could not create database'),
              onSuccess: (created) => router.push(`/w/${ws}/d/${created.id}`),
            },
          );
          setDatabaseOpen(false);
        }}
      />
    </Dialog>
  );

  return {
    addDatabase: () => setDatabaseOpen(true),
    addDocument: () => createDocument.mutate(),
    busy: createDocument.isPending || mutations.createDatabase.isPending,
    dialog,
  };
}

/** Space-level documents and views: what makes a space not-empty besides its databases. Same query keys as the sidebar's. */
export function useSpaceContents(ws: string, spaceId: string, enabled: boolean) {
  const documents = useQuery({
    queryKey: ['space-docs', ws, spaceId],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });
  const views = useQuery({
    queryKey: ['space-views', ws, spaceId],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/views', {
        params: { path: { ws, space: spaceId } },
      } as never);
      if (error) throw error;
      return (data as unknown as {
        data: Array<{ id: string; name: string; database_id: string | null; personal: boolean }>;
      }).data;
    },
  });
  return {
    documents: documents.data ?? [],
    // A view that belongs to a database is listed under that database; a personal view lives only under Personal (#1097).
    views: (views.data ?? []).filter((v) => v.database_id === null && !v.personal),
    // Until both lists have answered we do not know the space is empty, and must not flash the empty state over a full space.
    settled: !enabled || (!documents.isLoading && !views.isLoading),
  };
}

/** "+ New ▾" in the page header: the way to add, always one click away, whether the space is empty or full. */
export function SpaceNewMenu({
  onDatabase,
  onDocument,
  onPack,
  busy,
}: {
  onDatabase: () => void;
  onDocument: () => void;
  /** Omitted for someone who may not install packs (admin-only on the API): the item is simply not there. */
  onPack?: () => void;
  busy: boolean;
}) {
  const row =(icon: ReactNode, title: string, hint: string) => (
    <span className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted">{icon}</span>
      <span className="flex flex-col">
        <span className="text-body font-medium text-ink">{title}</span>
        <span className="text-label text-muted">{hint}</span>
      </span>
    </span>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" disabled={busy} aria-label="New in this space">
          <Plus className="h-3.5 w-3.5" aria-hidden /> New <ChevronDown className="h-3 w-3" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onDatabase}>
          {row(<Database className="h-3.5 w-3.5" />, 'Database', 'A table of records you can view as a board, list or calendar')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDocument}>
          {row(<FileText className="h-3.5 w-3.5" />, 'Document', 'A page of writing')}
        </DropdownMenuItem>
        {onPack && (
          <DropdownMenuItem onSelect={onPack}>
            {row(<Package className="h-3.5 w-3.5" />, 'From a pack…', 'A ready-made set of databases and views')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The bar directly under the header of an empty space: the first thing after the name, never below the fold (#1094). */
export function StartFromScratchBar({
  onDatabase,
  onDocument,
  note,
  busy,
}: {
  onDatabase: () => void;
  onDocument: () => void;
  /** The bar's right-hand line: an invitation to the cards below (admins), or who can add a pack (everyone else). */
  note: string;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2.5">
      <b className="mr-1 text-body font-semibold text-ink">Start from scratch</b>
      <Button type="button" variant="secondary" disabled={busy} onClick={onDatabase}>
        <Database className="h-3.5 w-3.5" aria-hidden /> New database
      </Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onDocument}>
        <FileText className="h-3.5 w-3.5" aria-hidden /> New document
      </Button>
      <span className="ml-auto text-label text-muted">{note}</span>
    </div>
  );
}

/**
 * One card per pack, all in ONE style (Ievgen, #1094: "the other packs are not visible, they should be styled the same way"),
 * the featured ones leading. Cards open the install review for THIS space via `onPick`; the page owns the dialog.
 *
 * #1149 filled the seam #1145 left: the why line is the pack's own `why` (its manifest's one sentence, via the registry listing)
 * and the map is drawn from the listing's `relations`. A pack with no `why` falls back to its own `summary` — a real sentence,
 * never an invented one — and a pack with no relations draws no map. `why`/`map` props still override both (tests, other callers).
 */
export function SpacePackGrid({
  onPick,
  why,
  map,
}: {
  onPick: (slug: string) => void;
  why?: (pack: RegistryCard) => string | undefined;
  map?: (pack: RegistryCard) => ReactNode;
}) {
  const registry = useRegistry();
  const [filter, setFilter] = useState<string>(ALL_PACKS);
  const packs = registry.data ?? [];
  const filters = spacePackFilters(packs, registryVertical, PACK_FILTERS);
  // A chip that stopped existing (the list changed under it) must not leave the grid empty.
  const active = filters.some((f) => f.value === filter) ? filter : ALL_PACKS;
  const shown = visibleSpacePacks(packs, active, registryVertical);

  if (registry.isLoading) return <p className="text-body text-muted">Loading ready-made setups…</p>;
  if (registry.isError) {
    return <p className="text-body text-muted">Could not load the ready-made setups. New database and New document still work.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div role="group" aria-label="Filter by kind of work" className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={active === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'h-[26px] rounded-full border bg-card px-2.5 text-label text-ink-secondary hover:border-border-strong',
              active === f.value ? 'border-primary text-ink shadow-[inset_0_0_0_1px_var(--primary)]' : 'border-border-default',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(224px,1fr))] gap-2.5">
        {shown.map((pack) => (
          <li key={pack.slug} className="flex">
            <button
              type="button"
              onClick={() => onPick(pack.slug)}
              data-pack={pack.slug}
              className={cn(
                // The approved shape: roughly square (1:1.08) from the tablet width up, content height on a phone. It is drawn
                // around the database map (#1145), so until that arrives the lower half is empty, as in the prototype.
                'flex w-full flex-col gap-2 overflow-hidden rounded-[var(--radius-card)] border bg-card p-3 text-left hover:border-border-strong md:aspect-[1/1.08]',
                FEATURED_SPACE_PACKS.includes(pack.slug) ? 'border-border-strong' : 'border-border-default',
              )}
            >
              <b className="text-prose font-semibold text-ink">{pack.name}</b>
              <p className="line-clamp-3 text-label leading-[1.45] text-ink-secondary">{why?.(pack) ?? pack.why ?? pack.summary}</p>
              {map ? (
                map(pack)
              ) : (
                <PackMap slug={pack.slug} relations={pack.relations} databaseCount={pack.preview.databases} soleDatabase={pack.workflow?.database} limit={4} />
              )}
              <span className="mt-auto font-mono text-meta text-muted">{packCountsLine(pack.preview)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
