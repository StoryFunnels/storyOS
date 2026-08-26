'use client';

import { useEffect, useState } from 'react';
// #254 — the list now comes from the shared registry, so this overlay and the
// hover tooltips can never drift apart.
import { SHORTCUTS, formatShortcut, useIsMac, useShortcut } from '@/lib/shortcuts';
import { OPEN_SHORTCUTS_EVENT } from '@/lib/shortcuts';

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const isMac = useIsMac();
  useShortcut('?', () => setOpen((o) => !o));
  /*
   * #396 — "?" is no longer the only way in, which was the entire bug: the
   * cheat-sheet had exactly the property it exists to cure. The sidebar entry
   * and the command palette both dispatch this.
   */
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(15,23,41,0.35)]" onClick={() => setOpen(false)}>
      <div
        className="mx-auto mt-28 w-full max-w-sm rounded-[var(--radius-modal)] border border-border-default bg-card p-5 shadow-[0_20px_50px_rgba(15,23,41,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink">Keyboard shortcuts</h2>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-[13px]">
              <span className="text-ink-secondary">{s.label}</span>
              <kbd className="rounded border border-border-default bg-canvas px-1.5 py-0.5 text-[11px] text-muted">
                {formatShortcut(s.keys, isMac)}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
