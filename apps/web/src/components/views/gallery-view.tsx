'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { recordHref } from '@/lib/records';
import { useDatabase, useMembers, useRecordsInfinite } from '../table-view/use-table-data';
import { Card } from './board-view';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

/** Gallery view (MN-090): records as a responsive grid of cards — a board with no
 * columns. Reuses the MN-089 card (title + chips + colored triangles). */
export function GalleryView({
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
  const cardFields = useMemo(
    () => (database.data?.fields ?? []).filter((f) => config.card_field_ids.includes(f.id)),
    [database.data, config.card_field_ids],
  );

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-faint">No records yet.</p>;
  }

  const min = config.card_size === 'large' ? 280 : config.card_size === 'small' ? 180 : 220;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
        {rows.map((row) => (
          <div key={row.id} onClick={() => router.push(recordHref(ws, db, row))}>
            <Card
              row={row}
              cardFields={cardFields}
              size={config.card_size ?? 'medium'}
              memberNames={memberNames}
              memberImages={memberImages}
            />
          </div>
        ))}
      </div>
      {records.hasNextPage && (
        <button
          className="mt-3 rounded px-2 py-1 text-[13px] text-info hover:bg-hover"
          onClick={() => void records.fetchNextPage()}
          disabled={records.isFetchingNextPage}
        >
          {records.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
