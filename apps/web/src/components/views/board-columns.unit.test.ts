import { describe, expect, it } from 'vitest';
import { arrangeBoardColumns, hiddenBoardColumns, NO_VALUE, showBoardColumn, visibleBoardColumns } from './board-columns';

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

/**
 * #1182 — a view's `hidden_option_ids`. Each case below is a rule a plausible implementation breaks: dropping the
 * no-value bucket, re-ordering the survivors, crashing on a stale id, or losing the cards of a hidden column.
 */
describe('#1182 — hidden board columns', () => {
  const STATES = [
    col('triage', 'Triage', 1),
    col('todo', 'To Do', 2),
    col('doing', 'In Progress', 3),
    col('done', 'Done', 4),
    { id: NO_VALUE, label: 'No value', rows: Array.from({ length: 1 }) },
  ];
  const ids = (xs: Array<{ id: string }>) => xs.map((c) => c.id);

  it('removes the hidden columns and keeps the rest in their original order', () => {
    expect(ids(visibleBoardColumns(STATES, ['done', 'triage']))).toEqual(['todo', 'doing', NO_VALUE]);
  });

  it('none hidden (absent, empty) is every column, as a board that never hid one', () => {
    expect(ids(visibleBoardColumns(STATES, undefined))).toEqual(ids(STATES));
    expect(ids(visibleBoardColumns(STATES, []))).toEqual(ids(STATES));
  });

  it('an id that matches no column is ignored — a stale one never throws and never hides anything else', () => {
    expect(ids(visibleBoardColumns(STATES, ['ghost', 'done']))).toEqual(['triage', 'todo', 'doing', NO_VALUE]);
    expect(hiddenBoardColumns(STATES, ['ghost'])).toEqual([]);
  });

  it('the no-value bucket can never be hidden, even by an entry that names it', () => {
    expect(ids(visibleBoardColumns(STATES, [NO_VALUE]))).toContain(NO_VALUE);
    expect(hiddenBoardColumns(STATES, [NO_VALUE])).toEqual([]);
  });

  it('the hidden list is the complement, in the field\'s own order (not the order the ids were saved in)', () => {
    expect(ids(hiddenBoardColumns(STATES, ['done', 'triage']))).toEqual(['triage', 'done']);
  });

  it('hiding does not touch the input, and a hidden column KEEPS its cards (they stay counted, never re-bucketed)', () => {
    const before = STATES.map((c) => c.rows.length);
    visibleBoardColumns(STATES, ['done']);
    expect(STATES.map((c) => c.rows.length)).toEqual(before);
    const hidden = hiddenBoardColumns(STATES, ['done']);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.rows).toHaveLength(4);
    // the shown columns do not gain the hidden column's cards: "No value" is still just its own one card
    const shown = arrangeBoardColumns(STATES, { hidden_option_ids: ['done'] }, { groupType: 'select', hasMore: false });
    expect(shown.find((c) => c.id === NO_VALUE)!.rows).toHaveLength(1);
  });

  it('arrangeBoardColumns hides them even while more pages are loading (a hidden column is a choice, not an inference)', () => {
    const out = arrangeBoardColumns(STATES, { hidden_option_ids: ['triage'] }, { groupType: 'select', hasMore: true });
    expect(ids(out)).toEqual(['todo', 'doing', 'done', NO_VALUE]);
  });

  it('composes with the other rules: hide-empty and column order act on what is left', () => {
    const out = arrangeBoardColumns(
      [col('a', 'Alpha', 0), col('b', 'Bravo', 2), col('c', 'Charlie', 5)],
      { hidden_option_ids: ['c'], hide_empty_groups: true, column_sort: 'alpha' },
      { groupType: 'select', hasMore: false },
    );
    expect(ids(out)).toEqual(['b']);
  });

  it('with every option hidden, only the No value bucket is left (it cannot be hidden)', () => {
    expect(ids(arrangeBoardColumns(STATES, { hidden_option_ids: ['triage', 'todo', 'doing', 'done'] }, { groupType: 'select', hasMore: false }))).toEqual([NO_VALUE]);
  });
});

describe('#1182 — Show (what the Display menu writes)', () => {
  const OPTIONS = [{ id: 'triage' }, { id: 'todo' }, { id: 'done' }];

  it('restoring a column removes it from the list; the others stay hidden', () => {
    expect(showBoardColumn(OPTIONS, ['triage', 'done'], 'triage')).toEqual(['done']);
    expect(ids2(hiddenBoardColumns(OPTIONS, showBoardColumn(OPTIONS, ['triage', 'done'], 'triage')))).toEqual(['done']);
  });

  it('restoring the last one leaves NO key at all (undefined), not an empty list', () => {
    expect(showBoardColumn(OPTIONS, ['done'], 'done')).toBeUndefined();
  });

  it('a stale id is dropped on the way, so re-saving never sends the API an id it refuses', () => {
    expect(showBoardColumn(OPTIONS, ['ghost', 'triage', 'done'], 'done')).toEqual(['triage']);
    expect(showBoardColumn(OPTIONS, ['ghost'], 'triage')).toBeUndefined();
  });

  it('showing a column that is not hidden changes nothing about the rest', () => {
    expect(showBoardColumn(OPTIONS, ['done'], 'todo')).toEqual(['done']);
  });
});
const ids2 = (xs: Array<{ id: string }>) => xs.map((c) => c.id);
