'use client';

import { useSyncExternalStore } from 'react';

/**
 * #835 — the transient "find in this view" text.
 *
 * Deliberately NOT part of `ViewConfig`, the draft, or the personal-filter
 * resource: it must never ride the auto-save PATCH into the shared view and
 * must never change what anyone else sees. A module-level store gives exactly
 * that lifetime — it survives switching between the table and the board of one
 * database, and a reload clears it. The search box also clears it when the
 * database page unmounts, so a narrowing you can no longer see never lingers.
 * Keyed by database so a search cannot leak into an unrelated list.
 */
const MAX_LEN = 200; // mirrors the API's `q` cap on /records/query

const store = new Map<string, string>();
const listeners = new Set<() => void>();

/** What actually goes on the wire: trimmed, capped, and `undefined` when blank. */
export function normalizeSearch(raw: string | undefined | null): string | undefined {
  const q = (raw ?? '').trim().slice(0, MAX_LEN);
  return q === '' ? undefined : q;
}

export function setViewSearch(db: string, text: string) {
  if (text === '') store.delete(db);
  else store.set(db, text);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The raw text as typed (untrimmed, so the input does not fight the caret). */
export function useViewSearchText(db: string): string {
  return useSyncExternalStore(
    subscribe,
    () => store.get(db) ?? '',
    () => '',
  );
}

/** The normalised query every view sends, or undefined when there is none. */
export function useViewSearch(db: string): string | undefined {
  return normalizeSearch(useViewSearchText(db));
}
