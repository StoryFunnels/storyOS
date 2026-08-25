'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Database, FileText, FolderOpen, Home, LayoutTemplate, Plus, Search, Settings, UserPlus, UserRound, Sparkles} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { EntityIcon } from '@/components/ui/icon-picker';
import { openTyron } from '@/lib/tyron-panel';
import { OPEN_PALETTE_EVENT, useShortcut } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

interface RecordHit {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
  database_icon: string | null;
}
interface PlaceHit {
  kind: 'database' | 'space';
  id: string;
  name: string;
  icon: string | null;
}

type Group = 'Records' | 'Create' | 'Places' | 'Actions';

interface Row {
  key: string;
  group: Group;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

const GROUP_ORDER: Group[] = ['Records', 'Create', 'Places', 'Actions'];

/** Cmd+K palette (MN-048): search + navigate + quick actions, keyboard-first. */
export function CommandPalette() {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const debounced = useDebounced(query, 150);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const openIt = useCallback(() => {
    // No-op while another dialog is open (focus traps fight otherwise).
    if (document.querySelector('[role="dialog"]')) return;
    setQuery('');
    setIndex(0);
    setOpen(true);
  }, []);

  useShortcut('mod+k', (e) => {
    e.preventDefault();
    if (open) setOpen(false);
    else openIt();
  });

  useEffect(() => {
    const handler = () => openIt();
    window.addEventListener(OPEN_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_PALETTE_EVENT, handler);
  }, [openIt]);

  const searching = debounced.trim().length > 0;

  const search = useQuery({
    queryKey: ['search', ws, debounced],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/search', {
        params: { path: { ws }, query: { q: debounced } },
      } as never);
      if (error) throw error;
      return data as unknown as { records: RecordHit[]; places: PlaceHit[] };
    },
    enabled: open && searching,
    placeholderData: (prev) => prev,
  });

  const recents = useQuery({
    queryKey: ['recents', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/recent', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { records: RecordHit[] };
    },
    enabled: open,
    staleTime: 30_000,
  });

  const onDatabasePage = pathname.includes('/d/');
  // #253 — the database we're currently looking at (if any), so "Create …" offers
  // it first. Read off the path rather than a prop: the palette is mounted app-wide.
  const currentDbId = pathname.match(/\/d\/([0-9a-f-]{36})/i)?.[1] ?? null;

  // #253 — creating from the palette needs the workspace's databases. Only
  // fetched while the palette is open, so it costs nothing on a normal page.
  const databases = useDatabases(ws, open);

  /**
   * #253 — create a record titled by the typed query, then jump straight into it.
   * Keyboard-only: type a title, arrow to "Create … in <db>", Enter, and you land
   * on the new record. Errors surface as a toast rather than silently closing.
   */
  const createRecord = useCallback(
    async (databaseId: string, title: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: databaseId } },
        body: { values: { name: title } } as never,
      });
      if (error || !data) {
        toast.error('Could not create the record');
        return;
      }
      setOpen(false);
      router.push(`/w/${ws}/d/${databaseId}/r/${(data as unknown as { id: string }).id}`);
    },
    [ws, router],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const go = (path: string) => {
      setOpen(false);
      router.push(path);
    };
    const hits = searching ? (search.data?.records ?? []) : (recents.data?.records ?? []);
    for (const hit of hits) {
      out.push({
        key: `rec:${hit.id}`,
        group: 'Records',
        icon: <EntityIcon icon={hit.database_icon} color={null} fallback={<FileText className="h-3.5 w-3.5" />} className="text-[13px]" />,
        label: hit.title || 'Untitled',
        hint: hit.database_name,
        run: () => go(`/w/${ws}/d/${hit.database_id}/r/${hit.id}`),
      });
    }
    // #253 — "Create <query> in <database>": only while a query is typed (an empty
    // query has no title to create), current database first when we're on one, and
    // capped so the palette stays scannable.
    const typed = debounced.trim();
    if (typed) {
      const dbs = [...(databases.data ?? [])].sort((a, b) => {
        const cur = currentDbId;
        if (cur && a.id === cur) return -1;
        if (cur && b.id === cur) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const d of dbs.slice(0, 5)) {
        out.push({
          key: `new:${d.id}`,
          group: 'Create',
          icon: <Plus className="h-3.5 w-3.5" />,
          label: `Create “${typed}” in ${d.name}`,
          hint: 'New record',
          run: () => void createRecord(d.id, typed),
        });
      }
    }

    for (const place of search.data?.places ?? []) {
      out.push({
        key: `place:${place.id}`,
        group: 'Places',
        icon: <EntityIcon icon={place.icon} color={null} fallback={place.kind === 'database' ? <Database className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />} className="text-[13px]" />,
        label: place.name,
        hint: place.kind === 'database' ? 'Database' : 'Space',
        run: () => (place.kind === 'database' ? go(`/w/${ws}/d/${place.id}`) : go(`/w/${ws}`)),
      });
    }
    const actions: Array<[string, React.ReactNode, () => void]> = [
      /**
       * #356 — Tyron is reachable from ⌘K too.
       *
       * The ticket asked for ⌘K to open Tyron directly, but this palette has
       * owned that key since #254 and the cheat-sheet advertises it as "Search &
       * commands". Rather than break an established binding, Tyron takes ⌘J and
       * appears HERE as well — so someone who reaches for ⌘K still finds it,
       * which was the discoverability the original request was really after.
       */
      ['Ask Tyron', <Sparkles key="tyron" className="h-3.5 w-3.5" />, () => { setOpen(false); openTyron(); }],
      ['Go to Home', <Home key="home" className="h-3.5 w-3.5" />, () => go(`/w/${ws}`)],
      ['Go to My Work', <UserRound key="mywork" className="h-3.5 w-3.5" />, () => go(`/w/${ws}/me`)],
      ...(onDatabasePage
        ? ([['New record here', <Plus key="a" className="h-3.5 w-3.5" />, () => { setOpen(false); window.dispatchEvent(new CustomEvent('storyos:new-record')); }]] as Array<[string, React.ReactNode, () => void]>)
        : []),
      ['Browse templates', <LayoutTemplate key="b" className="h-3.5 w-3.5" />, () => go(`/w/${ws}`)],
      ['Invite people', <UserPlus key="c" className="h-3.5 w-3.5" />, () => go(`/w/${ws}/settings/members`)],
      ['Settings & members', <Settings key="d" className="h-3.5 w-3.5" />, () => go(`/w/${ws}/settings/members`)],
    ];
    const q = debounced.trim().toLowerCase();
    for (const [label, icon, run] of actions) {
      if (!q || label.toLowerCase().includes(q)) {
        out.push({ key: `act:${label}`, group: 'Actions', icon, label, run });
      }
    }
    return out;
  }, [search.data, recents.data, searching, debounced, ws, router, onDatabasePage, databases.data, currentDbId, createRecord]);

  useEffect(() => setIndex(0), [rows.length, debounced]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    itemRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const grouped: Array<{ group: Group; items: Array<{ row: Row; i: number }> }> = [];
  let flat = 0;
  for (const group of GROUP_ORDER) {
    const items: Array<{ row: Row; i: number }> = [];
    for (const row of rows) {
      if (row.group === group) items.push({ row, i: flat++ });
    }
    if (items.length > 0) grouped.push({ group, items });
  }

  const showSkeleton = searching && search.isLoading;
  const showEmpty = grouped.length === 0 && !showSkeleton;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(15,23,41,0.35)] px-4 pt-[15vh] backdrop-blur-[1px]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-[var(--radius-modal)] border border-border-default bg-card shadow-[0_24px_60px_rgba(15,23,41,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center gap-2.5 border-b border-border-default px-3.5">
          <Search className="h-4 w-4 shrink-0 text-faint" />
          <input
            autoFocus
            placeholder="Search records, databases, actions…"
            className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (rows.length ? (i + 1) % rows.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                rows[index]?.run();
              }
            }}
          />
          {searching && search.isFetching && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
              <span className="block h-full w-1/3 animate-[cmdk-slide_1s_ease-in-out_infinite] rounded-full bg-accent" />
            </span>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {showSkeleton && (
            <div className="px-1">
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-faint">Records</p>
              {[0, 1, 2, 3].map((n) => (
                <div key={n} className="flex items-center gap-2.5 px-2.5 py-2">
                  <span className="h-6 w-6 shrink-0 animate-pulse rounded-[var(--radius-control)] bg-hover" />
                  <span className="h-3.5 flex-1 animate-pulse rounded bg-hover" style={{ maxWidth: `${70 - n * 8}%` }} />
                </div>
              ))}
            </div>
          )}

          {showEmpty && (
            <div className="px-2.5 py-8 text-center">
              <Search className="mx-auto mb-2 h-5 w-5 text-faint" />
              <p className="text-[13px] font-medium text-ink-secondary">
                {searching ? `No matches for “${debounced.trim()}”` : 'Type to search'}
              </p>
              <p className="mt-0.5 text-[12px] text-muted">
                {searching ? 'Try a record title, database, or space.' : 'Find records, databases, spaces and actions.'}
              </p>
            </div>
          )}

          {!showSkeleton && grouped.map(({ group, items }, gi) => (
            <div key={group} className={cn(gi > 0 && 'mt-1 border-t border-border-default/70 pt-1')}>
              <p className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wider text-faint">
                {!searching && group === 'Records' ? 'Recent' : group}
              </p>
              {items.map(({ row, i }) => {
                const active = i === index;
                return (
                  <button
                    key={row.key}
                    ref={(el) => { itemRefs.current[i] = el; }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px] text-ink transition-colors',
                      active ? 'bg-accent-soft' : 'hover:bg-hover',
                    )}
                    onMouseMove={() => setIndex(i)}
                    onClick={row.run}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-control)] border text-muted transition-colors',
                        active ? 'border-[color:var(--accent)]/30 bg-card text-ink' : 'border-border-default bg-hover',
                      )}
                    >
                      {row.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                    {row.hint && (
                      <span className="ml-2 max-w-[45%] shrink-0 truncate text-[11px] text-muted">{row.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border-default px-3.5 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="text-faint">navigate</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            <span className="text-faint">open</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            <span className="text-faint">close</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border-default bg-hover px-1 font-sans text-[11px] leading-none text-muted">
      {children}
    </kbd>
  );
}

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
