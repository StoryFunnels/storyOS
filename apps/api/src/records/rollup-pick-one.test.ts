import { describe, expect, it } from 'vitest';
import { compareOrderValues, isPickOneOp, pickOneRow, rollupFieldValue, type PickableRow } from './rollup-pick-one';

/**
 * #286 — the ordering rules for first/last rollups. Tested directly rather than
 * only through a seeded database because every interesting failure here is a
 * comparison edge case (nulls, mixed types, ties), and those are cheap to state
 * and expensive to reproduce through fixtures.
 */

const NO_LABELS = new Map<string, string>();

function row(id: string, values: Record<string, unknown> = {}, extra: Partial<PickableRow> = {}): PickableRow {
  return { id, title: null, number: null, createdAt: null, updatedAt: null, values, ...extra };
}

describe('isPickOneOp', () => {
  it('accepts only first/last', () => {
    expect(isPickOneOp('first')).toBe(true);
    expect(isPickOneOp('last')).toBe(true);
    for (const op of ['count', 'sum', 'avg', 'min', 'max', undefined, null, 'FIRST']) {
      expect(isPickOneOp(op)).toBe(false);
    }
  });
});

describe('compareOrderValues', () => {
  it('orders numbers numerically, not as text', () => {
    // The trap: "10" < "9" lexicographically, so a record #10 would lose to #9.
    expect(compareOrderValues(10, 9)).toBeGreaterThan(0);
  });

  it('orders dates chronologically, whether Date or ISO string', () => {
    expect(compareOrderValues(new Date('2026-03-01'), new Date('2026-01-01'))).toBeGreaterThan(0);
    expect(compareOrderValues('2026-03-01', '2026-01-01')).toBeGreaterThan(0);
    expect(compareOrderValues('2026-01-01T23:00:00Z', new Date('2026-01-01T01:00:00Z'))).toBeGreaterThan(0);
  });

  it('orders text case-insensitively', () => {
    expect(compareOrderValues('acme', 'Acme')).toBe(0);
    expect(compareOrderValues('Beta', 'acme')).toBeGreaterThan(0);
  });

  it('does not treat free text that merely mentions a date as a date', () => {
    // new Date("Dec 2026") parses; if it were accepted, a text column would order
    // as dates on some rows and as text on others.
    expect(compareOrderValues('Dec 2026', 'Apr 2026')).toBeGreaterThan(0); // text order
  });

  it('buckets mixed types instead of interleaving them', () => {
    const mixed = [7, 'apple', true, new Date('2026-01-01')];
    const sorted = [...mixed].sort(compareOrderValues);
    // A half-migrated column must produce a STABLE order — the exact bucket
    // order matters less than it not depending on input order.
    expect([...mixed].reverse().sort(compareOrderValues)).toEqual(sorted);
  });

  it('is a consistent total order (antisymmetric)', () => {
    for (const [a, b] of [[1, 2], ['a', 'b'], [true, false], ['2026-01-01', '2026-02-01']] as const) {
      expect(Math.sign(compareOrderValues(a, b))).toBe(-Math.sign(compareOrderValues(b, a)));
    }
  });
});

describe('pickOneRow', () => {
  const rows = [row('a', { n: 3 }), row('b', { n: 9 }), row('c', { n: 1 })];
  const byN = (r: PickableRow) => (r.values as Record<string, unknown>)['n'];

  it('last takes the largest, first the smallest', () => {
    expect(pickOneRow(rows, 'last', byN)?.id).toBe('b');
    expect(pickOneRow(rows, 'first', byN)?.id).toBe('c');
  });

  it('skips rows with no ordering value rather than ranking them', () => {
    // "The latest Invoice" must never be one with no date at all.
    const withGaps = [row('a', { n: null }), row('b', {}), row('c', { n: 2 }), row('d', { n: '' })];
    expect(pickOneRow(withGaps, 'last', byN)?.id).toBe('c');
    expect(pickOneRow(withGaps, 'first', byN)?.id).toBe('c');
  });

  it('is null when nothing has an ordering value', () => {
    expect(pickOneRow([row('a', {}), row('b', { n: null })], 'last', byN)).toBeNull();
    expect(pickOneRow([], 'last', byN)).toBeNull();
  });

  it('breaks ties on record id, identically for first and last', () => {
    const tied = [row('c', { n: 5 }), row('a', { n: 5 }), row('b', { n: 5 })];
    expect(pickOneRow(tied, 'last', byN)?.id).toBe('a');
    expect(pickOneRow(tied, 'first', byN)?.id).toBe('a');
  });

  it('is order-independent, so read-time and recompute paths agree', () => {
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(pickOneRow(shuffled, 'last', byN)?.id).toBe(pickOneRow(rows, 'last', byN)?.id);
  });
});

describe('rollupFieldValue', () => {
  it('reads column-backed fields, not the values bag', () => {
    // "Last Ticket by ID" — the ticket's headline example — orders by `number`,
    // which has no entry in `values` at all.
    const r = row('a', {}, {
      title: 'Fix the thing',
      number: 42,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-02-01'),
      createdBy: 'user_1',
      updatedBy: 'user_2',
    });
    expect(rollupFieldValue(r, { id: 'x', type: 'title' }, NO_LABELS)).toBe('Fix the thing');
    expect(rollupFieldValue(r, { id: 'x', type: 'id' }, NO_LABELS)).toBe(42);
    expect(rollupFieldValue(r, { id: 'x', type: 'created_at' }, NO_LABELS)).toEqual(new Date('2026-01-01'));
    expect(rollupFieldValue(r, { id: 'x', type: 'updated_at' }, NO_LABELS)).toEqual(new Date('2026-02-01'));
    expect(rollupFieldValue(r, { id: 'x', type: 'created_by' }, NO_LABELS)).toBe('user_1');
    expect(rollupFieldValue(r, { id: 'x', type: 'updated_by' }, NO_LABELS)).toBe('user_2');
  });

  it('resolves select ids to labels', () => {
    // Ordering by option id would be ordering by random uuid bytes.
    const labels = new Map([['opt_1', 'Done']]);
    expect(rollupFieldValue(row('a', { f1: 'opt_1' }), { id: 'f1', type: 'select' }, labels)).toBe('Done');
    expect(rollupFieldValue(row('a', { f1: 'opt_1' }), { id: 'f1', type: 'workflow' }, labels)).toBe('Done');
    expect(rollupFieldValue(row('a', { f1: ['opt_1', 'gone'] }), { id: 'f1', type: 'multi_select' }, labels)).toEqual(['Done']);
  });

  it('returns plain stored values otherwise, and null when absent', () => {
    expect(rollupFieldValue(row('a', { f1: 'hello' }), { id: 'f1', type: 'text' }, NO_LABELS)).toBe('hello');
    expect(rollupFieldValue(row('a', { f1: 0 }), { id: 'f1', type: 'number' }, NO_LABELS)).toBe(0);
    expect(rollupFieldValue(row('a', {}), { id: 'f1', type: 'text' }, NO_LABELS)).toBeNull();
    expect(rollupFieldValue(row('a', { f1: null }), { id: 'f1', type: 'text' }, NO_LABELS)).toBeNull();
  });
});
