'use client';

import { useEffect } from 'react';

/**
 * #1018 — a focus ring is for the KEYBOARD.
 *
 * `:focus-visible` is meant to do this on its own, but a click that is followed by script focus (a route change, a
 * dialog closing, a menu returning focus to its trigger) can still match it, and then a row you only clicked draws a
 * gold box. This records how the last interaction happened — `data-modality` on <html>, `pointer` after a mouse or
 * touch press and `keyboard` after a key that moves focus — and globals.css hides the ring on non-text controls while
 * it is `pointer`. Text fields keep their ring: someone typing needs to see where.
 */
const FOCUS_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End']);

export function useInputModality(): void {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => (root.dataset.modality = 'pointer');
    const key = (e: KeyboardEvent) => {
      if (FOCUS_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) root.dataset.modality = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      delete root.dataset.modality;
    };
  }, []);
}
