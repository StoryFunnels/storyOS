'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { runLastUndo, shouldHandleUndoShortcut } from '@/lib/undo';

/**
 * #265 — binds Cmd/Ctrl+Z to the record-undo stack.
 *
 * Mounted once in the workspace shell rather than per view, deliberately: the
 * AC is that undo works "even after changing views", and a listener owned by
 * the table would die with it on navigation.
 *
 * Shift+Cmd+Z (redo) is intentionally NOT bound. Redo over a restore is a
 * meaningfully different promise — it would re-delete records — and the stack
 * has no redo side. Leaving it unbound is better than binding it to something
 * surprising.
 */
export function UndoHotkey() {
  useEffect(() => {
    async function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      // Shift+Cmd+Z is redo on every platform — not ours to take.
      if (event.shiftKey) return;
      // Typing wins: text fields and the rich-text editor own their own undo.
      if (!shouldHandleUndoShortcut(event.target)) return;

      // Only claim the event once we know we have something to undo, so an
      // empty stack leaves the browser's own behaviour alone.
      try {
        const result = await runLastUndo();
        if (!result) return;
        event.preventDefault();
        toast.success(result.label);
      } catch {
        toast.error('Could not undo that — check the trash.');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}
