'use client';

import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { SettingsBox, SettingsRow } from '@/components/settings/settings-chrome';

/**
 * #618 — the one place that renders a "deleted things, with a Restore button"
 * list. Records, views, databases and spaces trash all render identically
 * (a bordered card, one row per item, a label + "Deleted <when>" + Restore) —
 * this is that shared shape, so a fifth trashable type doesn't re-draw it a
 * fifth time.
 *
 * Ticket #1189: `chrome="settings"` draws the same rows in the Settings page chrome (a titled box, rows at the Settings row height,
 * the count on the right) for the workspace Trash page. It is a different frame around the same list, never a second list: the
 * label, the "Deleted <when>" line and the Restore button are one code path.
 */
export function TrashSection<T extends { id: string; deleted_at: string }>({
  title,
  items,
  emptyText,
  label,
  meta,
  onRestore,
  restoringId,
  chrome = 'page',
}: {
  title: string;
  items: T[];
  emptyText: string;
  label: (item: T) => string;
  meta?: (item: T) => string | null;
  onRestore: (item: T) => void;
  restoringId?: string;
  chrome?: 'page' | 'settings';
}) {
  const fmt = useDateFormat();

  if (chrome === 'settings') {
    return (
      <SettingsBox title={title} aside={items.length}>
        {items.length === 0 && <SettingsRow title={emptyText} />}
        {items.map((item) => (
          <SettingsRow
            key={item.id}
            title={
              <>
                {label(item) || 'Untitled'}
                {meta?.(item) && <span className="ml-1.5 font-normal text-muted">{meta(item)}</span>}
              </>
            }
            description={`Deleted ${fmt.dateTime(item.deleted_at)}`}
          >
            <Button variant="secondary" size="sm" disabled={restoringId === item.id} onClick={() => onRestore(item)}>
              Restore
            </Button>
          </SettingsRow>
        ))}
      </SettingsBox>
    );
  }

  return (
    <div>
      <h2 className="mb-2 text-label font-medium uppercase tracking-wider text-muted">{title}</h2>
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
                  {meta?.(item) && <span className="ml-1.5 text-body text-muted">{meta(item)}</span>}
                </p>
                <p className="text-body text-muted">Deleted {fmt.dateTime(item.deleted_at)}</p>
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
