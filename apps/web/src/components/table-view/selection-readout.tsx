'use client';

import { opLabel } from '../views/dashboard-tiles';
import { SELECTION_OPS, formatSelectionValue } from './selection-summary';
import type { SelectionSummary } from './selection-summary';
import { cn } from '@/lib/utils';

/**
 * #580 — a transient status strip for the cell range the user has selected.
 * No dialog, no name, no save: it exists exactly while the range does, and the
 * parent unmounts it when the range is cleared. Nothing it shows is persisted.
 *
 * Every op is always listed, an em dash where a rollup would return null — a
 * selection of text cells reads "Sum —", not a hidden row, so it never claims
 * something the rollup would not.
 */
export function SelectionReadout({ summary }: { summary: SelectionSummary }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="selection-readout"
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-6rem)] max-md:left-4 max-md:right-auto flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-border-default bg-card px-3 py-1.5 text-label text-muted shadow-lg"
    >
      <span className="text-ink-secondary">
        {summary.cells} cell{summary.cells === 1 ? '' : 's'}
      </span>
      {SELECTION_OPS.map((op) => {
        const text = formatSelectionValue(summary, op);
        return (
          <span key={op} className="whitespace-nowrap">
            {opLabel(op)}{' '}
            <span className={cn('tabular-nums', text === '—' ? 'text-faint' : 'text-ink')}>{text}</span>
          </span>
        );
      })}
    </div>
  );
}
