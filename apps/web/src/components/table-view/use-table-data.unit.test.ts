import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { isRecordsPageCache, recordCountKey, recordsKey } from './use-table-data';

/**
 * #728 fix — the bug this pins: `useRecordCount`'s cache entry used to live
 * under `[...recordsKey(ws, db), 'count', filter]`, which TanStack Query's
 * `setQueriesData`/`getQueriesData` match by PREFIX against `recordsKey(ws,
 * db)` alone. Every optimistic update in `useRecordMutations` (edit, create,
 * delete) ran its `{ pages: [...] }` updater over that plain-number cache
 * entry too, threw on the first `.pages` access, and — because the throw
 * happened inside `onMutate`, before `mutationFn` — silently aborted the
 * whole mutation with no network request and a generic toast. Reproduced
 * live: selecting a new option in a Status/Owner cell did nothing, no PATCH
 * ever left the browser.
 *
 * This doesn't re-render the table (no renderHook convention exists in this
 * app yet) — it exercises the actual mechanism the bug lived in: a real
 * `QueryClient`'s own prefix-matching, seeded with the shapes
 * `useRecordsInfinite` and `useRecordCount` actually produce.
 */
describe('recordsKey / recordCountKey no longer collide, and setAll fails safe if they ever do (#728)', () => {
  it('a records-list cache entry is the only one setQueriesData(recordsKey) touches', () => {
    const qc = new QueryClient();
    const ws = 'ws-1';
    const db = 'db-1';

    qc.setQueryData([...recordsKey(ws, db), { limit: 100 }], { pages: [{ data: [], next_cursor: null }] });
    qc.setQueryData([...recordCountKey(ws, db), undefined], 5);

    // The exact call `setAll` makes, guard included — this is what a
    // deleteRecord/createRecord/updateRecord optimistic update runs.
    qc.setQueriesData({ queryKey: recordsKey(ws, db) }, (old: unknown) =>
      isRecordsPageCache(old) ? { ...old, pages: [] } : old,
    );

    expect(qc.getQueryData([...recordCountKey(ws, db), undefined])).toBe(5);
  });

  it('isRecordsPageCache rejects a plain count value instead of letting `.pages` throw', () => {
    expect(isRecordsPageCache(5)).toBe(false);
    expect(isRecordsPageCache(undefined)).toBe(false);
    expect(isRecordsPageCache({ pages: [] })).toBe(true);
  });

  it('recordsKey and recordCountKey start with different segments — never prefix-compatible again', () => {
    expect(recordsKey('ws', 'db')[0]).not.toBe(recordCountKey('ws', 'db')[0]);
  });
});
