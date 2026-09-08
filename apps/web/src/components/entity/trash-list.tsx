'use client';

import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';

/**
 * #618 — the one place that renders a "deleted things, with a Restore button"
 * list. Records, views, databases and spaces trash all render identically
 * (a bordered card, one row per item, a label + "Deleted <when>" + Restore) —
 * this is that shared shape, so a fifth trashable type doesn't re-draw it a
 * fifth time.
 */
export function TrashSection<T extends { id: string; deleted_at: string }>({
  title,
  items,
  emptyText,
  label,
  meta,
  onRestore,
  restoringId,
}: {
  title: string;
  items: T[];
  emptyText: string;
  label: (item: T) => string;
  meta?: (item: T) => string | null;
  onRestore: (item: T) => void;
  restoringId?: string;
}) {
  const fmt = useDateFormat();
  return (
    <div>
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-muted">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
            >
              <div>
                <p className="text-sm text-ink">
                  {label(item) || 'Untitled'}
                  {meta?.(item) && <span className="ml-1.5 text-[13px] text-muted">{meta(item)}</span>}
                </p>
                <p className="text-[13px] text-muted">Deleted {fmt.dateTime(item.deleted_at)}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={restoringId === item.id}
                onClick={() => onRestore(item)}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
