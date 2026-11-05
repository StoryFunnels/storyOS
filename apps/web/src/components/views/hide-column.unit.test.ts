import { describe, expect, it } from 'vitest';
import {
  ALL_HIDDEN_LINK_TARGET,
  allHiddenNotice,
  allOptionColumnsHidden,
  focusTargetAfterHide,
  arrangeBoardColumns,
  canHideBoardColumn,
  hideBoardColumn,
  NO_VALUE,
  showBoardColumn,
  visibleBoardColumns,
} from './board-columns';

/**
 * #1162 — the column header menu's "Hide column". The component only calls these; the rules live here so they can be
 * tested without React.
 */
const col = (id: string, label: string, n = 1) => ({ id, label, rows: Array.from({ length: n }) });
const COLS = [col('triage', 'Triage'), col('todo', 'To Do'), col('done', 'Done'), col(NO_VALUE, 'No value')];

describe('#1162 — hideBoardColumn (what the menu writes)', () => {
  it('appends the id when nothing was hidden', () => {
    expect(hideBoardColumn(COLS, undefined, 'todo')).toEqual(['todo']);
  });

  it('keeps the ids already hidden, in order, and adds the new one at the end', () => {
    expect(hideBoardColumn(COLS, ['done'], 'triage')).toEqual(['done', 'triage']);
  });

  it('hiding an already hidden column does not duplicate it', () => {
    expect(hideBoardColumn(COLS, ['todo'], 'todo')).toEqual(['todo']);
  });

  it('the no-value bucket cannot be hidden: asking changes nothing (and a stray __none__ is not written)', () => {
    expect(hideBoardColumn(COLS, ['todo'], NO_VALUE)).toEqual(['todo']);
    expect(hideBoardColumn(COLS, undefined, NO_VALUE)).toBeUndefined();
    expect(hideBoardColumn(COLS, [NO_VALUE, 'todo'], 'done')).toEqual(['todo', 'done']);
  });

  it('drops a stale id on the way (the API refuses ids that are not options of the group-by field)', () => {
    expect(hideBoardColumn(COLS, ['deleted-option'], 'todo')).toEqual(['todo']);
  });

  it('an id naming no live column is not written', () => {
    expect(hideBoardColumn(COLS, undefined, 'nope')).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const hidden = ['done'];
    hideBoardColumn(COLS, hidden, 'todo');
    expect(hidden).toEqual(['done']);
  });
});

describe('#1162 — who is offered Hide column', () => {
  const ok = { columnId: 'todo', groupType: 'select', readOnly: false };
  it('an editor sees it on a select or workflow column', () => {
    expect(canHideBoardColumn(ok)).toBe(true);
    expect(canHideBoardColumn({ ...ok, groupType: 'workflow' })).toBe(true);
  });
  it('a viewer sees no menu', () => {
    expect(canHideBoardColumn({ ...ok, readOnly: true })).toBe(false);
  });
  it('the no-value column has no Hide item', () => {
    expect(canHideBoardColumn({ ...ok, columnId: NO_VALUE })).toBe(false);
  });
  it('a user, relation, date, text or unknown grouping has none: the server would 422 the write', () => {
    for (const groupType of ['user', 'relation', 'date', 'text', 'lookup', 'number', undefined]) {
      expect(canHideBoardColumn({ ...ok, groupType }), String(groupType)).toBe(false);
    }
  });
});

describe('#1162 review — the all-hidden notice', () => {
  it('counts the option columns only when EVERY one is hidden (the no-value bucket is not one)', () => {
    expect(allOptionColumnsHidden(COLS, ['triage', 'todo', 'done'])).toBe(3);
  });
  it('partial hiding gets no notice (Dev Tracker Active stays as it is)', () => {
    expect(allOptionColumnsHidden(COLS, ['triage', 'todo'])).toBe(0);
    expect(allOptionColumnsHidden(COLS, undefined)).toBe(0);
  });
  it('a board with no option columns at all gets none', () => {
    expect(allOptionColumnsHidden([col(NO_VALUE, 'No value')], undefined)).toBe(0);
  });
  it('stale ids do not count toward "all"', () => {
    expect(allOptionColumnsHidden(COLS, ['triage', 'todo', 'gone'])).toBe(0);
  });
  it('words come from the data: N and the field name, singular for one', () => {
    expect(allHiddenNotice(5, 'Status')).toEqual({ text: 'All 5 Status columns are hidden.', link: 'Show them in Display' });
    expect(allHiddenNotice(1, 'Status')).toEqual({ text: 'The 1 Status column is hidden.', link: 'Show it in Display' });
  });
});

describe('#1162 review — where focus goes after Hide', () => {
  const ids = ['a', 'b', 'c'];
  it('middle: the next visible column', () => expect(focusTargetAfterHide(ids, 'b')).toBe('c'));
  it('first: the next visible column', () => expect(focusTargetAfterHide(ids, 'a')).toBe('b'));
  it('last: the previous column', () => expect(focusTargetAfterHide(ids, 'c')).toBe('b'));
  it('only one left: the notice link', () => expect(focusTargetAfterHide(['a'], 'a')).toBe(ALL_HIDDEN_LINK_TARGET));
});

describe('#1162 — the round trip through the shared helpers', () => {
  it('Hide then Show gives back the original list (and nothing when it started empty)', () => {
    const hidden = hideBoardColumn(COLS, undefined, 'todo');
    expect(showBoardColumn(COLS, hidden, 'todo')).toBeUndefined();
    const two = hideBoardColumn(COLS, ['done'], 'todo');
    expect(showBoardColumn(COLS, two, 'todo')).toEqual(['done']);
  });

  it('hiding the column removes it from the drawn columns and nothing else', () => {
    const hidden = hideBoardColumn(COLS, undefined, 'todo');
    expect(visibleBoardColumns(COLS, hidden).map((c) => c.id)).toEqual(['triage', 'done', NO_VALUE]);
  });

  it('hiding the LAST visible option column is allowed: only the no-value bucket is left, cards are not re-bucketed', () => {
    let hidden: string[] | undefined;
    for (const id of ['triage', 'todo', 'done']) hidden = hideBoardColumn(COLS, hidden, id);
    expect(hidden).toEqual(['triage', 'todo', 'done']);
    const arranged = arrangeBoardColumns(COLS, { hidden_option_ids: hidden }, { groupType: 'select', hasMore: false });
    expect(arranged.map((c) => c.id)).toEqual([NO_VALUE]);
    // the hidden columns' cards are still in the column list the counts read
    expect(COLS.find((c) => c.id === 'todo')!.rows).toHaveLength(1);
  });

  it('the view config keeps every other key: the page patch spreads the config, the menu only sets hidden_option_ids', () => {
    const config = { column_sort: 'alpha', hide_empty_groups: true, hide_empty_no_value_group: true, card_size: 'small' };
    const next = { ...config, ...{ hidden_option_ids: hideBoardColumn(COLS, undefined, 'todo') } };
    expect(next).toEqual({ ...config, hidden_option_ids: ['todo'] });
  });
});
