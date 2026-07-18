import { describe, expect, it } from 'vitest';
import { sortMyWorkRecords } from './sort-my-work';
import type { MyWorkSortConfig, SortableDenseField } from './sort-my-work';

/**
 * MN-252: My Work's client-side sort — same builder/spec as saved views
 * (ViewConfig.sorts / sorts_nulls), applied here to the already-fetched,
 * already-filtered rows instead of at the query layer (records.service.ts).
 * sortMyWorkRecords lives in sort-my-work.ts (not group-config.tsx) precisely
 * so this test can import it without pulling JSX into the module graph — see
 * that file's header comment and apps/web/vitest.config.ts.
 */

const fields: SortableDenseField[] = [
  { api_name: 'due', type: 'date' },
  { api_name: 'estimate', type: 'number' },
  {
    api_name: 'state',
    type: 'select',
    options: [
      { id: 'backlog', label: 'Backlog' },
      { id: 'doing', label: 'Doing' },
      { id: 'done', label: 'Done' },
    ],
  },
];

const rec = (id: string, values: Record<string, unknown>) => ({ id, values });

describe('sortMyWorkRecords', () => {
  it('is a no-op when the config has no sort keys', () => {
    const records = [rec('a', { estimate: 5 }), rec('b', { estimate: 1 })];
    expect(sortMyWorkRecords(records, fields, {})).toEqual(records);
  });

  it('sorts numerically ascending/descending', () => {
    const records = [rec('a', { estimate: 5 }), rec('b', { estimate: 1 }), rec('c', { estimate: 3 })];
    const asc = sortMyWorkRecords(records, fields, { sorts: [{ field: 'estimate', direction: 'asc' }] });
    expect(asc.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    const desc = sortMyWorkRecords(records, fields, { sorts: [{ field: 'estimate', direction: 'desc' }] });
    expect(desc.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks ties with the second sort key (multi-key precedence)', () => {
    const records = [
      rec('a', { state: 'doing', estimate: 5 }),
      rec('b', { state: 'doing', estimate: 1 }),
      rec('c', { state: 'backlog', estimate: 9 }),
    ];
    const config: MyWorkSortConfig = {
      sorts: [
        { field: 'state', direction: 'asc' }, // Backlog < Doing alphabetically
        { field: 'estimate', direction: 'asc' },
      ],
    };
    expect(sortMyWorkRecords(records, fields, config).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('compares select fields by option label, not the stored option id', () => {
    const records = [rec('a', { state: 'done' }), rec('b', { state: 'backlog' }), rec('c', { state: 'doing' })];
    const sorted = sortMyWorkRecords(records, fields, { sorts: [{ field: 'state', direction: 'asc' }] });
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']); // Backlog, Doing, Done
  });

  it('places empty values last by default, first when sorts_nulls is "first"', () => {
    const records = [rec('a', { estimate: 5 }), rec('b', {}), rec('c', { estimate: 1 })];
    const last = sortMyWorkRecords(records, fields, { sorts: [{ field: 'estimate', direction: 'asc' }] });
    expect(last.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    const first = sortMyWorkRecords(records, fields, {
      sorts: [{ field: 'estimate', direction: 'asc' }],
      sorts_nulls: 'first',
    });
    expect(first.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('ignores a sort key referencing a field that is no longer part of the dense field set', () => {
    const records = [rec('a', { estimate: 5 }), rec('b', { estimate: 1 })];
    const sorted = sortMyWorkRecords(records, fields, { sorts: [{ field: 'ghost', direction: 'asc' }] });
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b']); // unrelated fallback: original order preserved
  });
});
