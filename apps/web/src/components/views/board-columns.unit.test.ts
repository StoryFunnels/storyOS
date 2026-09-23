import { describe, expect, it } from 'vitest';
import { arrangeBoardColumns, NO_VALUE } from './board-columns';

/**
 * #427 / #428 — the column rules, each of which is a judgement call.
 */
const col = (id: string, label: string, n: number) => ({ id, label, rows: Array.from({ length: n }) });

const BOARD = [
  col('e1', 'Workspace Build', 0),
  col('e2', 'onboarding', 3),
  col('e3', 'Billing', 1),
  { id: NO_VALUE, label: 'Unassigned', rows: Array.from({ length: 2 }) },
];

describe('#428 — hiding empty groups', () => {
  it('is off by default — a board does not silently lose columns', () => {
    expect(arrangeBoardColumns(BOARD, {}, { groupType: 'relation', hasMore: false }).map((c) => c.id)).toEqual([
      'e1', 'e2', 'e3', NO_VALUE,
    ]);
  });

  it('drops empty groups when asked', () => {
    const out = arrangeBoardColumns(BOARD, { hide_empty_groups: true }, { groupType: 'relation', hasMore: false });
    expect(out.map((c) => c.id)).toEqual(['e2', 'e3', NO_VALUE]);
  });

  it('KEEPS the no-value bucket even when hiding empties — it has its own switch', () => {
    // The whole point of the two-toggle design. "No Epic" is the triage pile;
    // sweeping it away with the empty real epics is the obvious implementation
    // and the wrong one.
    const empty = [col('e1', 'Empty epic', 0), { id: NO_VALUE, label: 'Unassigned', rows: [] }];
    const out = arrangeBoardColumns(empty, { hide_empty_groups: true }, { groupType: 'relation', hasMore: false });
    expect(out.map((c) => c.id)).toEqual([NO_VALUE]);
  });

  it('drops the no-value bucket only via its OWN toggle, and only when empty', () => {
    const withCards = arrangeBoardColumns(BOARD, { hide_empty_no_value_group: true }, { groupType: 'relation', hasMore: false });
    expect(withCards.map((c) => c.id), 'it has 2 cards, so it stays').toContain(NO_VALUE);

    const empty = [col('e1', 'A', 1), { id: NO_VALUE, label: 'Unassigned', rows: [] }];
    const out = arrangeBoardColumns(empty, { hide_empty_no_value_group: true }, { groupType: 'relation', hasMore: false });
    expect(out.map((c) => c.id)).toEqual(['e1']);
  });

  it('applies both toggles independently', () => {
    const both = [col('e1', 'Empty', 0), col('e2', 'Full', 2), { id: NO_VALUE, label: 'Unassigned', rows: [] }];
    const out = arrangeBoardColumns(
      both,
      { hide_empty_groups: true, hide_empty_no_value_group: true },
      { groupType: 'relation', hasMore: false },
    );
    expect(out.map((c) => c.id)).toEqual(['e2']);
  });

  /**
   * #755 AC3 — a column empty on the pages loaded so far is not the same
   * fact as a column with nothing in it. Measured: grouping storyos/issues by
   * Type over page 1 of 740 records dropped Finding/Chore (56 real records)
   * because nothing on that page landed there. Both toggles must stay inert
   * while more pages remain unloaded, regardless of what the config asks for.
   */
  it('never drops a column for either toggle while hasMore is true, even with both requested', () => {
    const both = [col('e1', 'Empty on this page', 0), col('e2', 'Full', 2), { id: NO_VALUE, label: 'Unassigned', rows: [] }];
    const out = arrangeBoardColumns(
      both,
      { hide_empty_groups: true, hide_empty_no_value_group: true },
      { groupType: 'relation', hasMore: true },
    );
    expect(out.map((c) => c.id)).toEqual(['e1', 'e2', NO_VALUE]);
  });

  it('resumes hiding empty groups the moment hasMore turns false, same config unchanged', () => {
    const empty = [col('e1', 'Empty epic', 0), col('e2', 'Full', 1)];
    const prefs = { hide_empty_groups: true };
    expect(arrangeBoardColumns(empty, prefs, { groupType: 'relation', hasMore: true }).map((c) => c.id)).toEqual([
      'e1', 'e2',
    ]);
    expect(arrangeBoardColumns(empty, prefs, { groupType: 'relation', hasMore: false }).map((c) => c.id)).toEqual([
      'e2',
    ]);
  });
});

describe('#427 — column ordering', () => {
  it('leaves the natural order alone by default', () => {
    expect(arrangeBoardColumns(BOARD, { column_sort: 'natural' }, { groupType: 'select', hasMore: false }).map((c) => c.label))
      .toEqual(['Workspace Build', 'onboarding', 'Billing', 'Unassigned']);
  });

  it('sorts alphabetically, case-insensitively — the 18-epic board fix', () => {
    const out = arrangeBoardColumns(BOARD, { column_sort: 'alpha' }, { groupType: 'relation', hasMore: false });
    expect(out.map((c) => c.label)).toEqual(['Billing', 'onboarding', 'Workspace Build', 'Unassigned']);
  });

  it('sorts by card count, busiest first', () => {
    const out = arrangeBoardColumns(BOARD, { column_sort: 'count' }, { groupType: 'relation', hasMore: false });
    expect(out.map((c) => c.label)).toEqual(['onboarding', 'Billing', 'Workspace Build', 'Unassigned']);
  });

  it('keeps the no-value bucket LAST under every sort — it is not a value', () => {
    // Alphabetically "Unassigned" would land under U; by count it would be
    // second. Both are category errors.
    for (const column_sort of ['natural', 'alpha', 'count'] as const) {
      const out = arrangeBoardColumns(BOARD, { column_sort }, { groupType: 'relation', hasMore: false });
      expect(out.at(-1)!.id, `sort=${column_sort}`).toBe(NO_VALUE);
    }
  });

  it('never reorders a DATE board — its columns are chronological periods', () => {
    const dates = [col('2026-01', 'Jan', 5), col('2026-02', 'Feb', 1), col('2026-03', 'Mar', 9)];
    for (const column_sort of ['alpha', 'count'] as const) {
      expect(
        arrangeBoardColumns(dates, { column_sort }, { groupType: 'date', hasMore: false }).map((c) => c.id),
        `date board must ignore ${column_sort}`,
      ).toEqual(['2026-01', '2026-02', '2026-03']);
    }
  });

  it('is stable on ties, so equal columns do not reshuffle between renders', () => {
    const tied = [col('a', 'A', 2), col('b', 'B', 2), col('c', 'C', 2)];
    expect(arrangeBoardColumns(tied, { column_sort: 'count' }, { groupType: 'relation', hasMore: false }).map((c) => c.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('hides and sorts together, in that order', () => {
    const out = arrangeBoardColumns(
      BOARD,
      { hide_empty_groups: true, column_sort: 'alpha' },
      { groupType: 'relation', hasMore: false },
    );
    expect(out.map((c) => c.label)).toEqual(['Billing', 'onboarding', 'Unassigned']);
  });
});
