'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/avatar';
import { recordHref } from '@/lib/records';
import { useDateFormat } from '@/lib/preferences';
import { CardFieldChip } from './board-view';
import { richTextPreview, optionColor } from '../table-view/cells';
import { useDatabase, useMembers, useRecordsInfinite } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

/** Feed view (MN-093): a single-column stream of wide cards — title, a preview of
 * the record's first rich-text field, the card fields, and who/when. Built for
 * reviewing notes / feedback / updates. */
export function FeedView({
  ws,
  db,
  config,
  readOnly,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  const fmt = useDateFormat();
  const queryBody = useMemo(() => queryBodyFromConfig(config), [config]);
  const records = useRecordsInfinite(ws, db, queryBody);

  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );
  const memberImages = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.image])),
    [memberQuery.data],
  );

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const richField = database.data?.fields.find((f) => f.type === 'rich_text');
  // Preserve the saved card_field_ids order (MN-151), not schema order.
  const cardFields = useMemo(
    () =>
      config.card_field_ids
        .map((id) => (database.data?.fields ?? []).find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => Boolean(f)),
    [database.data, config.card_field_ids],
  );
  const colorField = database.data?.fields.find((f) => f.id === config.color_by_field_id);

  if (rows.length === 0) return <p className="p-6 text-sm text-faint">No records yet.</p>;

  return (
    <div className="h-full overflow-auto">
      <div className="flex max-w-2xl flex-col gap-3 px-4 py-4">
        {rows.map((row) => {
          const preview = richField ? richTextPreview(row.values[richField.apiName], 280) : '';
          const author = row.created_by;
          const dot = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
          return (
            <div
              key={row.id}
              onClick={() => router.push(recordHref(ws, db, row))}
              style={dot ? { borderLeftColor: dot, borderLeftWidth: 3 } : undefined}
              className="cursor-pointer rounded-[var(--radius-card)] border border-border-default bg-card p-4 hover:border-border-strong"
            >
              <p className="text-[15px] font-semibold text-ink">{row.title || 'Untitled'}</p>
              {preview && <p className="mt-1.5 line-clamp-4 text-[13px] text-ink-secondary">{preview}</p>}
              {cardFields.length > 0 && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {cardFields.map((field) => {
                    const value = field.type === 'title' ? row.title : row.values[field.apiName];
                    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
                    return (
                      <CardFieldChip key={field.id} field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex items-center gap-1.5 border-t border-border-default pt-2 text-[11px] text-faint">
                {author && <Avatar userId={author} name={memberNames.get(author) ?? '?'} image={memberImages?.get(author)} size={16} />}
                {author && <span>{memberNames.get(author) ?? 'Someone'}</span>}
                <span>·</span>
                <span>{fmt.date(row.created_at)}</span>
                {row.number !== null && <span className="ml-auto tabular-nums">#{row.number}</span>}
              </div>
            </div>
          );
        })}
        {records.hasNextPage && (
          <button
            className="self-center rounded px-2 py-1 text-[13px] text-info hover:bg-hover"
            onClick={() => void records.fetchNextPage()}
            disabled={records.isFetchingNextPage}
          >
            {records.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
