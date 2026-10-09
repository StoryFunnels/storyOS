'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { recordHref, recordSegment } from '@/lib/records';
import { isTypingTarget, useShortcut, useShortcutKeys } from '@/lib/shortcuts';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { cn } from '@/lib/utils';
import { queryBodyFromConfig, type FilterNode, type ViewConfig } from './use-view-state';
import { normalizeSearch, setViewSearch, useViewSearchText } from './view-search';
import { stepIndex } from '@/lib/list-nav';
import { useRecordCount, useRecordsInfinite } from '@/components/table-view/use-table-data';

/** How many matches the results list shows. Narrowing the text reaches the rest;
 * the list says how many more there are rather than pretending it is complete. */
const FIND_RESULT_LIMIT = 8;

/**
 * #835 — "find in this view": ⌘/Ctrl+F opens this box, typing narrows the view's
 * records by title SERVER-SIDE (so rows that were never paged in are found too),
 * Esc clears it, Enter opens the first match.
 *
 * Transient by construction — the text lives in `view-search.ts`, never in the
 * view config, so it cannot reach the auto-save PATCH or another viewer.
 *
 * Mounted by the view toolbar, which only exists on a database view page; that is
 * what scopes the shortcut (record pages, documents and settings never mount it,
 * so the browser's own find still works there).
 */
export function ViewSearchBox({
  ws,
  db,
  config,
  personalFilter,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  personalFilter?: FilterNode;
}) {
  const text = useViewSearchText(db);
  const [open, setOpen] = useState(text !== '');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // Same entry point as `e` in the grid and the Open chip (#199), so Enter and a
  // click cannot disagree about split panel vs full page.
  const openRecord = useOpenRecord();
  const hint = useShortcutKeys('find');

  // #838 — the matches, for ↑/↓ + Enter. The SAME server-side query the view
  // itself runs (view filters + personal filter + sort + q), capped small, so it
  // reaches rows that were never paged in and agrees with what the view shows.
  const q = normalizeSearch(text);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [q]); // a new search starts back on the first match
  const matchBody = useMemo(
    (): Record<string, unknown> | undefined =>
      q ? { ...queryBodyFromConfig(config, personalFilter, q), limit: FIND_RESULT_LIMIT } : undefined,
    [config, personalFilter, q],
  );
  const matchQuery = useRecordsInfinite(ws, db, matchBody, Boolean(q));
  const matches = q ? (matchQuery.data?.pages[0]?.data ?? []) : [];
  const totalMatches = useRecordCount(ws, db, matchBody?.['filter'], Boolean(q), q).data;

  useShortcut('mod+f', (e) => {
    // A text input, textarea or rich-text editor keeps the browser's find —
    // including THIS box: a second ⌘F while it is focused is the escape hatch
    // for people who want page find.
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    setOpen(true);
    // The input may not be mounted yet on the first press.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  });

  // Leaving the page (unmount) must not leave a search behind for the next visit
  // to this database: the AC is "reloading clears it", and a stale narrowing the
  // user cannot see is the worse failure.
  useEffect(() => () => setViewSearch(db, ''), [db]);

  function openRow(row: { id: string; title?: string | null; number?: number | null }) {
    openRecord(
      { db, rec: recordSegment(row), title: row.title ?? '', number: row.number ?? undefined },
      { button: 0, preventDefault: () => {} },
      () => router.push(recordHref(ws, db, row)),
    );
  }

  async function openFirstMatch() {
    const q = normalizeSearch(text);
    if (!q) return;
    // One row, in the view's own filters + sort order — what the first row of the
    // narrowed list is. Asking the server keeps this correct on a list whose first
    // page we never loaded.
    const body = { ...queryBodyFromConfig(config, personalFilter, q), limit: 1 };
    const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
      params: { path: { ws, db } },
      body: body as never,
    });
    if (error) return;
    const first = (data as unknown as { data: Array<{ id: string; title?: string | null; number?: number | null }> }).data[0];
    if (!first) return;
    openRow(first);
  }

  function close() {
    setViewSearch(db, '');
    setOpen(false);
    inputRef.current?.blur();
  }

  if (!open && text === '') {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        title={hint ? `Find in this view (${hint})` : 'Find in this view'}
        aria-label="Find in this view"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-label text-muted hover:bg-hover hover:text-ink"
      >
        <Search className="h-3.5 w-3.5" />
        Find
      </button>
    );
  }

  return (
    <div
      className={cn(
        'relative flex items-center gap-1 rounded border border-border-default bg-card px-1.5 py-0.5',
        'focus-within:border-accent',
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
      <input
        ref={inputRef}
        autoFocus
        value={text}
        maxLength={200}
        onChange={(e) => setViewSearch(db, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Claim it, so nothing behind this box (record panel, selection)
            // also reacts to the same keystroke.
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // Nothing to move through: leave the key to the page.
            if (matches.length === 0) return;
            e.preventDefault();
            setActive((i) => stepIndex(i, e.key === 'ArrowDown' ? 1 : -1, matches.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            // The highlighted match; with no arrow pressed that is the FIRST one,
            // exactly what #835 shipped. If the list has not loaded yet, fall back
            // to asking the server for the first match, as before.
            const row = matches[active];
            if (row) openRow(row);
            else void openFirstMatch();
          }
        }}
        placeholder="Find in this view…"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls="find-results"
        aria-activedescendant={matches[active] ? `find-result-${matches[active]!.id}` : undefined}
        aria-label="Find in this view"
        className="w-44 bg-transparent text-body text-ink outline-none placeholder:text-muted"
      />
      <button
        type="button"
        onClick={close}
        title="Clear search"
        aria-label="Clear search"
        className="rounded p-0.5 text-muted hover:bg-hover hover:text-ink"
      >
        <X className="h-3 w-3" />
      </button>

      {q && matches.length > 0 && (
        <ul
          id="find-results"
          role="listbox"
          aria-label="Matching records"
          className="absolute left-0 top-full z-[var(--z-popover)] mt-1 w-72 overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card p-1 shadow-[var(--shadow-palette)]"
        >
          {matches.map((row, i) => (
            <li key={row.id} role="presentation">
              <button
                type="button"
                id={`find-result-${row.id}`}
                role="option"
                aria-selected={i === active}
                // Keep focus in the box: clicking a result must not blur the input
                // (the typing stays live) before the open handler runs.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => openRow(row)}
                // The palette's own highlight, so the two result lists look alike.
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-body text-ink',
                  i === active ? 'bg-accent-soft' : 'hover:bg-hover',
                )}
              >
                {row.number != null && <span className="shrink-0 text-meta text-muted">#{row.number}</span>}
                <span className="min-w-0 flex-1 truncate font-medium">{row.title || 'Untitled'}</span>
              </button>
            </li>
          ))}
          {totalMatches !== undefined && totalMatches > matches.length && (
            <li role="presentation" className="px-2 py-1 text-meta text-muted">
              + {totalMatches - matches.length} more — keep typing to narrow
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
