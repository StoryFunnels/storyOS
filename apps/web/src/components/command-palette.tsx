'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Database, FileText, FolderOpen, LayoutTemplate, Plus, Search, Settings, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
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

interface Row {
  key: string;
  group: 'Records' | 'Places' | 'Actions';
  icon: React.ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

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

  const search = useQuery({
    queryKey: ['search', ws, debounced],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/search', {
        params: { path: { ws }, query: { q: debounced } },
      } as never);
      if (error) throw error;
      return data as unknown as { records: RecordHit[]; places: PlaceHit[] };
    },
    enabled: open && debounced.trim().length > 0,
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

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const go = (path: string) => {
      setOpen(false);
      router.push(path);
    };
    const hits = debounced.trim() ? (search.data?.records ?? []) : (recents.data?.records ?? []);
    for (const hit of hits) {
      out.push({
        key: `rec:${hit.id}`,
        group: 'Records',
        icon: hit.database_icon ? <span className="text-[13px]">{hit.database_icon}</span> : <FileText className="h-3.5 w-3.5" />,
        label: hit.title || 'Untitled',
        hint: hit.database_name,
        run: () => go(`/w/${ws}/d/${hit.database_id}/r/${hit.id}`),
      });
    }
    for (const place of search.data?.places ?? []) {
      out.push({
        key: `place:${place.id}`,
        group: 'Places',
        icon: place.icon ? <span className="text-[13px]">{place.icon}</span> : place.kind === 'database' ? <Database className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />,
        label: place.name,
        hint: place.kind,
        run: () => (place.kind === 'database' ? go(`/w/${ws}/d/${place.id}`) : go(`/w/${ws}`)),
      });
    }
    const actions: Array<[string, React.ReactNode, () => void]> = [
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
  }, [search.data, recents.data, debounced, ws, router, onDatabasePage]);

  useEffect(() => setIndex(0), [rows.length, debounced]);

  if (!open) return null;

  const grouped: Array<[string, Row[]]> = ['Records', 'Places', 'Actions']
    .map((g) => [g, rows.filter((r) => r.group === g)] as [string, Row[]])
    .filter(([, list]) => list.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-[rgba(15,23,41,0.35)]"
      onClick={() => setOpen(false)}
    >
      <div
        className="mx-auto mt-24 w-full max-w-lg rounded-[var(--radius-modal)] border border-border-default bg-card shadow-[0_20px_50px_rgba(15,23,41,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-default px-3">
          <Search className="h-4 w-4 text-faint" />
          <input
            autoFocus
            placeholder="Search records, databases, actions…"
            className="h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(rows.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                rows[index]?.run();
              }
            }}
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {grouped.length === 0 && (
            <p className="px-2.5 py-4 text-[13px] text-muted">
              {debounced.trim() ? `No matches for “${debounced.trim()}”.` : 'Nothing recent yet.'}
            </p>
          )}
          {grouped.map(([group, list]) => (
            <div key={group}>
              <p className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wider text-faint">
                {group}
              </p>
              {list.map((row) => {
                const i = rows.indexOf(row);
                return (
                  <button
                    key={row.key}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[13px] text-ink',
                      i === index ? 'bg-hover' : 'hover:bg-hover',
                    )}
                    onMouseEnter={() => setIndex(i)}
                    onClick={row.run}
                  >
                    <span className="flex w-4 justify-center text-muted">{row.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.hint && <span className="shrink-0 text-[11px] text-faint">{row.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-border-default px-3 py-1.5 text-[11px] text-faint">
          ↑↓ navigate · ↵ open · esc close
        </div>
      </div>
    </div>
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
