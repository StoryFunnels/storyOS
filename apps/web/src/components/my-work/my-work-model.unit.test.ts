import { describe, expect, it } from 'vitest';
import {
  appliedConditionCount,
  buildRows,
  dueBucket,
  facetsFor,
  filterChips,
  pickFacetFields,
  sortRows,
  type MyWorkGroup,
} from './my-work-model';
import type { DenseField } from './group-config';

const opt = (id: string, label: string, color = 'gray') => ({ id, label, color });
const FIELDS: DenseField[] = [
  { id: 'f1', api_name: 'state', display_name: 'State', type: 'workflow', options: [opt('o1', 'Todo'), opt('o2', 'Doing', 'blue')] },
  { id: 'f2', api_name: 'priority', display_name: 'Priority', type: 'select', options: [opt('p1', 'Low'), opt('p2', 'Urgent', 'red')] },
  { id: 'f3', api_name: 'due', display_name: 'Due date', type: 'date' },
  { id: 'f4', api_name: 'created', display_name: 'Created on', type: 'date' },
];

describe('pickFacetFields (#968)', () => {
  it('finds state by type, priority and due by name', () => {
    const f = pickFacetFields(FIELDS);
    expect(f.stateField?.id).toBe('f1');
    expect(f.priorityField?.id).toBe('f2');
    expect(f.dueField?.id).toBe('f3');
  });

  it('never calls an arbitrary date column the due date', () => {
    expect(pickFacetFields([FIELDS[3]!]).dueField).toBeNull();
  });

  it('falls back to a select named Status for the state', () => {
    const status: DenseField = { id: 's', api_name: 'status', display_name: 'Status', type: 'select', options: [opt('a', 'Open')] };
    expect(pickFacetFields([status]).stateField?.id).toBe('s');
  });
});

describe('facetsFor', () => {
  it('resolves option ids to labels and colour keys, and reads the due date', () => {
    const f = facetsFor(FIELDS, { state: 'o2', priority: ['p2'], due: '2026-10-30' });
    expect(f.state).toEqual({ label: 'Doing', color: 'blue' });
    expect(f.priority).toEqual({ label: 'Urgent', color: 'red' });
    expect(f.due).toBe('2026-10-30');
  });

  it('is all-null for an empty row, never undefined labels', () => {
    const f = facetsFor(FIELDS, {});
    expect([f.state, f.priority, f.due]).toEqual([null, null, null]);
  });
});

describe('dueBucket', () => {
  const now = new Date(2026, 9, 21, 15, 0, 0); // 21 Oct 2026, local
  it('reads a bare date as a calendar day', () => {
    expect(dueBucket('2026-10-20', now)).toBe('overdue');
    expect(dueBucket('2026-10-21', now)).toBe('today');
    expect(dueBucket('2026-10-22', now)).toBe('later');
  });
  it('is none without a date or with garbage', () => {
    expect(dueBucket(null, now)).toBe('none');
    expect(dueBucket('not a date', now)).toBe('none');
  });
});

const GROUPS: MyWorkGroup[] = [
  {
    database: { id: 'd1', name: 'Issues', icon: null, color: null },
    fields: FIELDS,
    records: [
      { id: 'r1', title: 'Late', number: 1, updated_at: '2026-10-01T00:00:00Z', values: { due: '2026-10-25', priority: 'p1' } },
      { id: 'r2', title: 'Soon', number: 2, updated_at: '2026-10-02T00:00:00Z', values: { due: '2026-10-22', priority: 'p2' } },
      { id: 'r3', title: 'Undated new', number: 3, updated_at: '2026-10-20T00:00:00Z', values: {} },
      { id: 'r4', title: 'Undated old', number: 4, updated_at: '2026-10-03T00:00:00Z', values: {} },
    ],
  },
];

describe('sortRows', () => {
  it('orders by due date, undated rows last and newest-updated first among them', () => {
    const rows = buildRows(GROUPS, {});
    expect(sortRows(rows, 'due').map((r) => r.record.id)).toEqual(['r2', 'r1', 'r3', 'r4']);
  });
  it('can sort by last updated or title', () => {
    const rows = buildRows(GROUPS, {});
    expect(sortRows(rows, 'updated').map((r) => r.record.id)).toEqual(['r3', 'r4', 'r2', 'r1']);
    expect(sortRows(rows, 'title').map((r) => r.record.title)).toEqual(['Late', 'Soon', 'Undated new', 'Undated old']);
  });
  it('does not mutate its input', () => {
    const rows = buildRows(GROUPS, {});
    const copy = [...rows];
    sortRows(rows, 'title');
    expect(rows).toEqual(copy);
  });
});

describe('saved per-database filters keep applying, and always show a chip (#968)', () => {
  const eqUrgent = { and: [{ field: 'priority', op: 'eq', value: 'p2' }] };

  it('buildRows applies the saved filter of each database', () => {
    const rows = buildRows(GROUPS, { d1: { filters: eqUrgent } });
    expect(rows.map((r) => r.record.id)).toEqual(['r2']);
  });

  it('a filter that applies names itself in a chip', () => {
    expect(filterChips(GROUPS, { d1: { filters: eqUrgent } })).toEqual([{ dbId: 'd1', label: 'Issues · 1 filter', count: 1 }]);
  });

  it('counts only conditions that apply: not disabled, not unfinished', () => {
    const mixed = {
      and: [
        { field: 'priority', op: 'eq', value: 'p2' },
        { field: 'priority', op: 'eq', value: 'p1', disabled: true },
        { field: 'priority', op: 'eq' }, // unfinished: no value
      ],
    };
    expect(appliedConditionCount(mixed)).toBe(1);
    expect(filterChips(GROUPS, { d1: { filters: mixed } })[0]?.label).toBe('Issues · 1 filter');
  });

  it('shows no chip for a database whose saved filter hides nothing, and pluralises', () => {
    expect(filterChips(GROUPS, {})).toEqual([]);
    const two = { and: [eqUrgent.and[0]!, { field: 'priority', op: 'neq', value: 'p1' }] };
    expect(filterChips(GROUPS, { d1: { filters: two } })[0]?.label).toBe('Issues · 2 filters');
  });
});

import { ASSIGNED_BY_UNRECORDED, assignedByLine } from './my-work-model';

describe('#968 follow-up: assignedByLine follows #979’s rule for null', () => {
  const by = { id: 'u1', name: 'Bea', kind: 'user' as const };

  it('names who set you, and when', () => {
    expect(assignedByLine({ assigned_by: by, assigned_at: '2026-10-20T10:00:00Z' }, 'assigned')).toEqual({
      kind: 'set',
      name: 'Bea',
      byAgent: false,
      at: '2026-10-20T10:00:00Z',
    });
  });

  it('marks an agent as an agent', () => {
    const line = assignedByLine({ assigned_by: { id: 'a1', name: 'Triage Bot', kind: 'agent' }, assigned_at: null }, 'assigned');
    expect(line).toMatchObject({ kind: 'set', byAgent: true, at: null });
  });

  it('null says what null means instead of a blank or an invented name', () => {
    const line = assignedByLine({ assigned_by: null, assigned_at: null }, 'assigned');
    expect(line).toEqual({ kind: 'unrecorded', explanation: ASSIGNED_BY_UNRECORDED });
    expect(ASSIGNED_BY_UNRECORDED).toMatch(/created or imported/);
    expect(ASSIGNED_BY_UNRECORDED).toMatch(/not in its history/);
  });

  it('an older server that omits the keys reads the same as null', () => {
    expect(assignedByLine({}, 'assigned').kind).toBe('unrecorded');
  });

  it('the Created tab has no assigner (you made it), so the row is not drawn, even if a value slipped through', () => {
    expect(assignedByLine({ assigned_by: null, assigned_at: null }, 'created')).toEqual({ kind: 'hidden' });
    expect(assignedByLine({ assigned_by: by, assigned_at: '2026-10-20T10:00:00Z' }, 'created')).toEqual({ kind: 'hidden' });
  });
});
