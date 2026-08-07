'use client';

import { useEffect } from 'react';

type Handler = (e: KeyboardEvent) => void;
const registry = new Map<string, Handler>();

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * #200 data-loss guard: a modal/dialog captures the keyboard. App shortcuts
 * (incl. mod-combos like Cmd+A) must NOT act on the page behind an open modal —
 * otherwise editing a field in a dialog and hitting Cmd+A selects every row
 * behind it (and a follow-up Delete trashes them).
 */
function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('[role="dialog"][data-state="open"], [aria-modal="true"]'));
}

let listening = false;
function ensureListener() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = `${mod ? 'mod+' : ''}${e.key.toLowerCase()}`;
    const handler = registry.get(key);
    if (!handler) return;
    // #200: a modal/dialog captures the keyboard — no app shortcut (even a
    // mod-combo) may act on the page behind it.
    if (isModalOpen()) return;
    // Plain-letter shortcuts never fire while typing; mod-combos always may.
    if (!mod && isTyping(e.target)) return;
    handler(e);
  });
}

/** One shared keydown listener for app shortcuts (MN-048; extended by MN-050). */
export function useShortcut(key: string, handler: Handler) {
  useEffect(() => {
    ensureListener();
    registry.set(key, handler);
    return () => {
      if (registry.get(key) === handler) registry.delete(key);
    };
  }, [key, handler]);
}

export const OPEN_PALETTE_EVENT = 'storyos:open-palette';
export function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/**
 * #254 — the single source of truth for every user-facing shortcut. Both the "?"
 * cheat-sheet (shortcuts-overlay.tsx) and the hover tooltips read this, so a
 * shortcut can never be renamed in one place and go stale in the other.
 *
 * `keys` is the DISPLAY form (⌘K, not mod+k) — the registry that actually binds
 * handlers is `useShortcut`'s own key strings, which stay lowercase/`mod+`.
 */
export interface ShortcutSpec {
  /** Stable id used by withShortcut() at call sites. */
  id: string;
  /** Display form, e.g. "⌘K". */
  keys: string;
  /** What it does, as shown in the cheat-sheet. */
  label: string;
}

export const SHORTCUTS: ShortcutSpec[] = [
  { id: 'palette', keys: '⌘K', label: 'Search & commands' },
  { id: 'new-record', keys: 'n', label: 'New record (on a database)' },
  { id: 'select-row', keys: 'x', label: 'Select row under cursor' },
  { id: 'select-range', keys: '⇧ + click', label: 'Select a range' },
  { id: 'select-all', keys: '⌘A', label: 'Select all loaded rows' },
  { id: 'open-record', keys: 'e', label: 'Open record under cursor' },
  { id: 'edit-cell', keys: 'Enter', label: 'Edit the focused cell' },
  { id: 'cancel', keys: 'Esc', label: 'Clear selection / cancel edit' },
  { id: 'help', keys: '?', label: 'Keyboard shortcuts' },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** The display keys for a registered shortcut, or null when the id is unknown. */
export function shortcutKeys(id: string): string | null {
  return BY_ID.get(id)?.keys ?? null;
}

/**
 * #254 — append a shortcut to a tooltip/aria label: `withShortcut('New record',
 * 'new-record')` → `"New record (n)"`. Returns the bare title when the id isn't
 * registered, so a typo degrades to today's behaviour instead of rendering
 * "undefined".
 */
export function withShortcut(title: string, id: string): string {
  const keys = shortcutKeys(id);
  return keys ? `${title} (${keys})` : title;
}
