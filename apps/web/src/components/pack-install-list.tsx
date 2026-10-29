'use client';

import type { ReactNode } from 'react';
import { Bot, Database, Kanban, LayoutGrid, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InstallRow } from '@/lib/pack-install-rows';

/**
 * #978 — the install dialog's one list. A row is an icon box, the item's name in a person's words, a muted line saying
 * what kind of thing it is, and — ONLY when it is not new — a note. Gold belongs to the agent row alone: it is the
 * thing that acts, and a gold badge on every row said nothing.
 */
export function RowIcon({ kind, viewType }: { kind: InstallRow['kind']; viewType?: string }) {
  const Glyph =
    kind === 'database'
      ? Database
      : kind === 'view'
        ? viewType === 'board'
          ? Kanban
          : LayoutGrid
        : kind === 'automation'
          ? Zap
          : Bot;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--radius-chip,4px)]',
        kind === 'agent'
          ? 'bg-active text-primary-text'
          : 'bg-hover text-muted',
      )}
      data-gold={kind === 'agent' ? 'true' : undefined}
    >
      <Glyph className="h-[13px] w-[13px]" />
    </span>
  );
}

export function InstallList({
  rows,
  renderExtra,
}: {
  rows: InstallRow[];
  /** What goes under a row's note: the "Use my X database" tick, the agent Keep/Take control, a collision select. */
  renderExtra?: (row: InstallRow) => ReactNode;
}) {
  return (
    <ul
      className="flex flex-col overflow-hidden rounded-[var(--radius-control)] border border-border-default"
      data-testid="pack-install-list"
    >
      {rows.map((row) => (
        <li
          key={`${row.kind}:${row.key}`}
          data-row-kind={row.kind}
          data-odd={row.action !== 'create' ? 'true' : undefined}
          className={cn(
            'flex items-start gap-2.5 border-t border-border-default px-2.5 py-2 first:border-t-0',
            row.action !== 'create' && 'bg-hover/60',
          )}
        >
          <RowIcon kind={row.kind} viewType={row.viewType} />
          <span className="flex min-w-0 flex-col gap-px text-body leading-[1.4]">
            <b className="font-medium text-ink">{row.name}</b>
            <span className="text-label text-muted">{row.sub}</span>
            {row.note && <em className="mt-0.5 text-label not-italic text-ink-secondary">{row.note}</em>}
            {renderExtra?.(row)}
          </span>
        </li>
      ))}
    </ul>
  );
}
