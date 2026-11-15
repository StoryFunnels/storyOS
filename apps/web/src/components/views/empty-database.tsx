'use client';

import { Plus } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { pluralNoun } from '@/lib/records';

/**
 * Coached empty state for a database with no records (#154, #400), in the shared shape (ticket #1291): the `big` EmptyState, centred
 * in the pane. Every record view shows THIS when the database is empty, table, board and calendar included (they used to show a bare
 * header row). The primary action calls back into the view's own create handler, so it stays consistent with how that view adds
 * records everywhere else; without one (a read-only viewer) only the coaching line is shown.
 *
 * NOTE: seeding actual sample rows is deliberately deferred — this ships the coached copy + primary action only.
 */
export function EmptyDatabase({
  noun = 'item',
  onAdd,
  description,
}: {
  /** Singular thing this database holds, e.g. "task". Falls back to "item". */
  noun?: string;
  /** The view's existing add-record handler; omitted for a viewer who cannot create. */
  onAdd?: () => void;
  /** #400 — the database's purpose line: an empty database is exactly the moment someone needs to know what belongs here. */
  description?: string | null;
}) {
  return (
    <EmptyState
      variant="big"
      fill
      data-testid="empty-database"
      title="Nothing here yet"
      description={description}
      body={onAdd ? `Add your first ${noun} to get started.` : `New ${pluralNoun(noun, 2)} will show up here.`}
      action={onAdd ? { label: `Add your first ${noun}`, onClick: onAdd, icon: <Plus className="h-3.5 w-3.5" aria-hidden /> } : undefined}
    />
  );
}

// #149 — the noun helper moved to @/lib/records so every surface can share it;
// re-exported here so existing importers keep working.
export { databaseNoun } from '@/lib/records';
