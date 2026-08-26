'use client';

import { Inbox, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Coached empty state (#154): shared across the feed/list/gallery (and table)
 * views so a brand-new database reads as "here's what goes here + add the first
 * one" instead of a bare "No records yet." The primary CTA calls back into the
 * view's own create/add handler, so it stays consistent with how that view adds
 * records everywhere else.
 *
 * NOTE: seeding actual sample rows is deliberately deferred — this ships the
 * coached copy + primary CTA only.
 */
export function EmptyState({
  noun = 'item',
  onAdd,
  description,
}: {
  /** Singular thing this database holds, e.g. "task". Falls back to "item". */
  noun?: string;
  /** The view's existing add-record handler. When omitted (e.g. read-only
   * viewers who cannot create), only the coaching copy is shown. */
  onAdd?: () => void;
  /**
   * #400 — the database's purpose line. This is the single best place for it:
   * an empty database is exactly the moment someone needs to know what belongs
   * here, and it is the one screen with room to say so.
   */
  description?: string | null;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-hover text-muted">
        <Inbox className="h-5 w-5" />
      </div>
      {description && (
        <p className="max-w-sm text-[13px] text-ink-secondary">{description}</p>
      )}
      <p className="max-w-sm text-[13px] text-muted">
        {onAdd
          ? `Nothing here yet. Add your first ${noun} to get started.`
          : `Nothing here yet. New ${noun}s will show up here.`}
      </p>
      {onAdd && (
        <Button type="button" size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Add your first {noun}
        </Button>
      )}
    </div>
  );
}

// #149 — the noun helper moved to @/lib/records so every surface can share it;
// re-exported here so existing importers keep working.
export { databaseNoun } from '@/lib/records';
