'use client';

import { useEffect, useSyncExternalStore } from 'react';

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

/**
 * #396 — open the cheat-sheet from somewhere other than the "?" key.
 *
 * The registry was fine and the overlay was fine; the only way IN was pressing
 * "?", and nothing anywhere told you to. The founder — who commissioned the
 * product — did not know the shortcuts existed, which is the strongest possible
 * evidence that no user did.
 */
export const OPEN_SHORTCUTS_EVENT = 'storyos:open-shortcuts';
export function openShortcuts() {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}
export function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/**
 * #254 — the single source of truth for every user-facing shortcut. Both the "?"
 * cheat-sheet (shortcuts-overlay.tsx) and the hover tooltips read this, so a
 * shortcut can never be renamed in one place and go stale in the other.
 *
 * #396 — `keys` is now PLATFORM-NEUTRAL (`mod+K`), not a mac glyph.
 *
 * It used to be the literal display string, so every hint the product showed
 * said ⌘ — on Windows and Linux, where the modifier is Ctrl, that taught people
 * a shortcut that does nothing. A wrong hint is worse than no hint: it costs a
 * try, and then trust. The binding layer already spoke `mod+`; only the display
 * did not, which is why the bug survived #254 unnoticed.
 *
 * `formatShortcut` turns a token into what the reader should see.
 */
export interface ShortcutSpec {
  /** Stable id used by withShortcut() at call sites. */
  id: string;
  /** Platform-neutral token, e.g. "mod+K". Rendered by `formatShortcut`. */
  keys: string;
  /** What it does, as shown in the cheat-sheet. */
  label: string;
}

export const SHORTCUTS: ShortcutSpec[] = [
  { id: 'palette', keys: 'mod+K', label: 'Search & commands' },
  /**
   * #356 asked for ⌘K, which the palette above has owned since #254 and which the
   * cheat-sheet already advertises. Taking it would have broken an established
   * binding to add a new one, so Tyron gets ⌘J — the conventional assistant-panel
   * key — and the palette gains an "Ask Tyron" entry, so ⌘K still reaches it.
   * Flagged on the ticket rather than decided silently.
   */
  { id: 'tyron', keys: 'mod+J', label: 'Ask Tyron' },
  { id: 'new-record', keys: 'n', label: 'New record (on a database)' },
  { id: 'select-row', keys: 'x', label: 'Select row under cursor' },
  { id: 'select-range', keys: '⇧ + click', label: 'Select a range' },
  { id: 'select-all', keys: 'mod+A', label: 'Select all loaded rows' },
  { id: 'open-record', keys: 'e', label: 'Open record under cursor' },
  { id: 'edit-cell', keys: 'Enter', label: 'Edit the focused cell' },
  { id: 'cancel', keys: 'Esc', label: 'Clear selection / cancel edit' },
  // #265: registered here so the overlay lists it. #322's lesson — a feature
  // nobody can discover is the same as a missing feature — and the founder
  // reported "no undo" while the product already had one.
  { id: 'undo', keys: 'mod+Z', label: 'Undo the last delete' },
  { id: 'help', keys: '?', label: 'Keyboard shortcuts' },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/**
 * #396 — render a token for the reader's platform.
 *
 * Pure and exported so it is testable without a DOM: the whole point is that
 * "⌘K on a Mac, Ctrl+K everywhere else" is asserted, not eyeballed on one
 * laptop — which is how the original bug shipped.
 *
 * Only `mod` is platform-dependent. ⇧, Enter and Esc read the same everywhere,
 * and a plain letter is a plain letter.
 */
export function formatShortcut(keys: string, isMac: boolean): string {
  if (!keys.includes('mod')) return keys;
  // "⌘K" has no separator on a Mac, "Ctrl+K" does — matching each platform's
  // own convention rather than picking one and applying it to both.
  return isMac ? keys.replace(/mod\+?/, '⌘') : keys.replace(/mod/, 'Ctrl');
}

/** Best-effort platform sniff. Only ever affects DISPLAY, never a binding. */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/.test(ua);
}

// `useSyncExternalStore` with a distinct SERVER snapshot, rather than a
// useState/useEffect pair. The server cannot know the platform, so the two
// renders legitimately differ; this is the API that expresses that without a
// hydration mismatch. The store never changes, so `subscribe` is a no-op.
const noopSubscribe = () => () => {};

/** True on Apple platforms. Server-renders as Mac, then corrects on hydration. */
export function useIsMac(): boolean {
  return useSyncExternalStore(noopSubscribe, detectMac, () => true);
}

/** The display keys for a shortcut, correct for THIS reader's platform. */
export function useShortcutKeys(id: string): string | null {
  const isMac = useIsMac();
  const keys = BY_ID.get(id)?.keys;
  return keys ? formatShortcut(keys, isMac) : null;
}

/** `withShortcut`, platform-aware. Use this in components. */
export function useWithShortcut(title: string, id: string): string {
  const keys = useShortcutKeys(id);
  return keys ? `${title} (${keys})` : title;
}

/**
 * The RAW token for a registered shortcut, or null when the id is unknown.
 *
 * Not for display — it returns "mod+K". Use `useShortcutKeys` in a component,
 * or `formatShortcut` where the platform is already known. Kept separate rather
 * than quietly formatting, so a caller cannot render "mod+K" to a user by
 * accident and have it look almost right.
 */
export function shortcutKeys(id: string): string | null {
  return BY_ID.get(id)?.keys ?? null;
}

/**
 * #254 — append a shortcut to a tooltip/aria label: `withShortcut('New record',
 * 'new-record')` → `"New record (n)"`. Returns the bare title when the id isn't
 * registered, so a typo degrades to today's behaviour instead of rendering
 * "undefined".
 */
export function withShortcut(title: string, id: string, isMac = true): string {
  const keys = shortcutKeys(id);
  return keys ? `${title} (${formatShortcut(keys, isMac)})` : title;
}
