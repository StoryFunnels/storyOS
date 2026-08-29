'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { recordHref, recordSegment } from '@/lib/records';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import { Card } from './board-view';
import { EmptyState, databaseNoun } from './empty-state';
import type { FilterNode, ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';
import { ViewQueryError } from './query-error';

/** Gallery view (MN-090): records as a responsive grid of cards — a board with no
 * columns. Reuses the MN-089 card (title + chips + colored triangles). */
export function GalleryView({
  ws,
  db,
  config,
  readOnly,
  personalFilter,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  // #199 — the shared split/navigate decision, identical on every surface.
  const openRecord = useOpenRecord('swap');
  const { createRecord } = useRecordMutations(ws, db);
  const queryBody = useMemo(() => queryBodyFromConfig(config, personalFilter), [config, personalFilter]);
  const records = useRecordsInfinite(ws, db, queryBody);

  const addRecord = () =>
    createRecord.mutate(
      { name: 'Untitled' },
      { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
    );

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
  /*
   * #391 — the gallery's card image.
   *
   * Resolved against the CURRENT field list, so a cover field that was deleted
   * simply stops being a cover rather than leaving cards asking for a thumbnail
   * that cannot exist. The type check matters as much as the existence check:
   * a config carried over from a field that was retyped must not send the card
   * looking for attachment chips in a text value.
   */
  const cover = useMemo(() => {
    const field = (database.data?.fields ?? []).find(
      (f) => f.id === config.cover_field_id && f.type === 'attachment',
    );
    return field ? { field, ws, db } : undefined;
  }, [database.data, config.cover_field_id, ws, db]);

  if (rows.length === 0) {
    return (
      <EmptyState
        noun={databaseNoun(database.data?.name)}
        onAdd={readOnly ? undefined : addRecord}
        description={database.data?.description}
      />
    );
  }

  const min = config.card_size === 'large' ? 280 : config.card_size === 'small' ? 180 : 220;

  // #346 — a rejected query must never render as an empty view. Placed after every
  // hook so the early return cannot change hook order.
  if (records.isError) return <ViewQueryError error={records.error} onRetry={() => void records.refetch()} />;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
        {rows.map((row) => (
          <div
            key={row.id}
            onClick={(e) =>
              openRecord(
                { db, rec: recordSegment(row), title: row.title, number: row.number },
                e,
                () => router.push(recordHref(ws, db, row)),
              )
            }
          >
            <Card
              row={row}
              cardFields={cardFields}
              size={config.card_size ?? 'medium'}
              memberNames={memberNames}
              memberImages={memberImages}
              cover={cover}
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
