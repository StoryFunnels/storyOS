'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { currentEntryId } from './nav-trail';

/**
 * #962 (q) / (v) — Back returns to where you were IN the list, not the top of it.
 *
 * The workspace's lists scroll inside their own container (a table body, a board, a feed), not the document, so the
 * browser's own scroll restoration never sees them: a phone user who opens the 40th record and swipes back lands on
 * row 1. This remembers, per history ENTRY, how far each scroll container inside `<main>` had been scrolled, and puts
 * it back when that entry is arrived at again. An entry that is new (a push) has nothing remembered, so it opens at
 * the top as it always did; only a traversal back finds a saved position.
 *
 * A container is named by its path of child indices from `<main>`, which is stable for as long as the same view is
 * on screen — a different layout simply finds nothing at that path and is left alone. Positions live in
 * sessionStorage, so a reload of an entry keeps them too, and are dropped with the tab.
 */
const STORE = 'storyos-scroll-memory';
const MAX_ENTRIES = 60;
/** How long to wait for rows to arrive before giving up on a saved position. */
const RESTORE_WINDOW_MS = 2500;

type Saved = Record<string, Record<string, number>>;

function read(): Saved {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

function write(saved: Saved): void {
  try {
    const keys = Object.keys(saved);
    // Newest entries last (insertion order); keep the tail so the store cannot grow without bound.
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete saved[k];
    sessionStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* private mode / blocked storage: the list just opens at the top, as before */
  }
}

/** The child-index path from `root` down to `el`, or null if `el` is not inside it. */
export function pathWithin(root: Element, el: Element): string | null {
  const parts: number[] = [];
  let node: Element | null = el;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    parts.push(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? parts.reverse().join('.') : null;
}

export function elementAt(root: Element, path: string): Element | null {
  let node: Element | null = root;
  for (const part of path === '' ? [] : path.split('.')) {
    node = node?.children[Number(part)] ?? null;
    if (!node) return null;
  }
  return node;
}

export function useScrollMemory(): void {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const key = `${currentEntryId()}|${pathname}?${search}`;
    // <main> may not exist yet (the layout shows its session check first), so it is looked up when needed.
    const mainEl = () => document.querySelector('main');

    // Save: every scroll inside <main> updates this entry's positions (one write per frame).
    let frame = 0;
    const pending = new Map<string, number>();
    const flush = () => {
      frame = 0;
      const saved = read();
      saved[key] = { ...(saved[key] ?? {}), ...Object.fromEntries(pending) };
      write(saved);
      pending.clear();
    };
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const main = mainEl();
      const path = main ? pathWithin(main, el) : null;
      if (path === null) return;
      pending.set(path, el.scrollTop);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    document.addEventListener('scroll', onScroll, true);

    // Restore: this entry was here before. Rows arrive after mount, so keep trying until the container is tall
    // enough to hold the position, then stop — never fighting a person who has started scrolling.
    const remembered = read()[key];
    let cancelled = false;
    let touched = false;
    const stop = () => (touched = true);
    if (remembered) {
      const started = performance.now();
      document.addEventListener('wheel', stop, { passive: true, once: true });
      document.addEventListener('touchstart', stop, { passive: true, once: true });
      const attempt = () => {
        if (cancelled || touched) return;
        const main = mainEl();
        if (!main) {
          if (performance.now() - started < RESTORE_WINDOW_MS) requestAnimationFrame(attempt);
          return;
        }
        let pendingLeft = 0;
        for (const [path, top] of Object.entries(remembered)) {
          const el = elementAt(main, path);
          if (!el || top <= 0) continue;
          if (el.scrollTop === top) continue;
          if (el.scrollHeight - el.clientHeight >= top) el.scrollTop = top;
          else pendingLeft += 1;
        }
        if (pendingLeft > 0 && performance.now() - started < RESTORE_WINDOW_MS) requestAnimationFrame(attempt);
      };
      requestAnimationFrame(attempt);
    }

    return () => {
      cancelled = true;
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('wheel', stop);
      document.removeEventListener('touchstart', stop);
      if (frame) {
        cancelAnimationFrame(frame);
        flush();
      }
    };
  }, [pathname, search]);
}
