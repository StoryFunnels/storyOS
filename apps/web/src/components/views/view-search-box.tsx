'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { recordHref, recordSegment } from '@/lib/records';
import { useShortcut, useShortcutKeys } from '@/lib/shortcuts';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { cn } from '@/lib/utils';
import { queryBodyFromConfig, type FilterNode, type ViewConfig } from './use-view-state';
import { normalizeSearch, setViewSearch, useViewSearchText } from './view-search';

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

  useShortcut('mod+f', (e) => {
    const t = e.target as HTMLElement | null;
    // A text input, textarea or rich-text editor keeps the browser's find —
    // including THIS box: a second ⌘F while it is focused is the escape hatch
    // for people who want page find.
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      return;
    }
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
    openRecord(
      { db, rec: recordSegment(first), title: first.title ?? '', number: first.number ?? undefined },
      { button: 0, preventDefault: () => {} },
      () => router.push(recordHref(ws, db, first)),
    );
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
        'flex items-center gap-1 rounded border border-border-default bg-card px-1.5 py-0.5',
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
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void openFirstMatch();
          }
        }}
        placeholder="Find in this view…"
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
    </div>
  );
}
