'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * #955 — one line, only when Linear's description changed since import (`description_drift`): the machine copy of
 * Linear's text is hidden on the record page, so this is the way to read it. Clearing the flag is the existing
 * Description Drift checkbox; this never writes.
 */
export function LinearDriftNotice({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5 rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2 text-label">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="text-warning">Linear&rsquo;s description changed since import.</span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-info hover:bg-hover"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide Linear’s text' : 'View Linear’s text'}
        </button>
      </div>
      {open && <p className="mt-2 whitespace-pre-wrap text-body text-ink-secondary">{text || '(empty in Linear)'}</p>}
    </div>
  );
}
