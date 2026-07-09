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

let listening = false;
function ensureListener() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = `${mod ? 'mod+' : ''}${e.key.toLowerCase()}`;
    const handler = registry.get(key);
    if (!handler) return;
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
