'use client';

import { useState } from 'react';
import { useShortcut } from '@/lib/shortcuts';

const SHORTCUTS: Array<[string, string]> = [
  ['⌘K', 'Search & commands'],
  ['n', 'New record (on a database)'],
  ['x', 'Select row under cursor'],
  ['⇧ + click', 'Select a range'],
  ['⌘A', 'Select all loaded rows'],
  ['e', 'Open record under cursor'],
  ['Enter', 'Edit the focused cell'],
  ['Esc', 'Clear selection / cancel edit'],
  ['?', 'This overlay'],
];

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  useShortcut('?', () => setOpen((o) => !o));
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(15,23,41,0.35)]" onClick={() => setOpen(false)}>
      <div
        className="mx-auto mt-28 w-full max-w-sm rounded-[var(--radius-modal)] border border-border-default bg-card p-5 shadow-[0_20px_50px_rgba(15,23,41,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink">Keyboard shortcuts</h2>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between text-[13px]">
              <span className="text-ink-secondary">{label}</span>
              <kbd className="rounded border border-border-default bg-canvas px-1.5 py-0.5 text-[11px] text-muted">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
