import { describe, expect, it } from 'vitest';
import {
  applyDrag,
  clampDragDelta,
  dependencyEdges,
  dragValuesToPersist,
  pxToDeltaDays,
  shiftDateString,
} from './timeline-math';

/**
 * #245: dependency lines + drag-to-reschedule. The date math is unit-tested in
 * isolation because an off-by-one here silently corrupts real dates — no
 * rendered component needed, these are pure functions.
 */

describe('shiftDateString', () => {
  it('shifts a date-only value by whole days', () => {
    expect(shiftDateString('2026-07-15', 1)).toBe('2026-07-16');
    expect(shiftDateString('2026-07-15', -1)).toBe('2026-07-14');
  });

  it('crosses a month boundary correctly', () => {
    expect(shiftDateString('2026-07-31', 1)).toBe('2026-08-01');
    expect(shiftDateString('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('crosses a year boundary correctly', () => {
    expect(shiftDateString('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles a leap-day correctly (2028 is a leap year)', () => {
    expect(shiftDateString('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDateString('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('preserves time-of-day on a datetime value, shifting only the date part', () => {
    expect(shiftDateString('2026-07-15T14:30', 3)).toBe('2026-07-18T14:30');
    expect(shiftDateString('2026-07-15T23:59', 1)).toBe('2026-07-16T23:59');
  });

  it('a zero delta returns the original value unchanged', () => {
    expect(shiftDateString('2026-07-15T09:00', 0)).toBe('2026-07-15T09:00');
  });

  it('a large multi-week delta still lands on the right day', () => {
    // 10 weeks forward from a fixed date, cross-checked against a manual count.
    expect(shiftDateString('2026-01-01', 70)).toBe('2026-03-12');
  });
});

describe('pxToDeltaDays', () => {
  it('rounds to the nearest whole day at the current zoom scale', () => {
    expect(pxToDeltaDays(45, 30)).toBe(2); // 1.5 rounds up
    expect(pxToDeltaDays(44, 30)).toBe(1); // ~1.47 rounds down
    expect(pxToDeltaDays(-45, 30)).toBe(-1); // Math.round(-1.5) rounds toward +Infinity
    expect(pxToDeltaDays(-46, 30)).toBe(-2);
    expect(pxToDeltaDays(0, 30)).toBe(0);
  });
});

describe('clampDragDelta', () => {
  it('move is never clamped', () => {
    expect(clampDragDelta('move', 999, 10, 12)).toBe(999);
    expect(clampDragDelta('move', -999, 10, 12)).toBe(-999);
  });

  it('resize-start cannot push start past end', () => {
    // start=10, end=12 -> max allowed forward delta is 2
    expect(clampDragDelta('resize-start', 5, 10, 12)).toBe(2);
    expect(clampDragDelta('resize-start', 1, 10, 12)).toBe(1); // within range, unclamped
    expect(clampDragDelta('resize-start', -5, 10, 12)).toBe(-5); // shrinking backward is fine
  });

  it('resize-end cannot push end before start', () => {
    // start=10, end=12 -> max allowed backward delta is -2
    expect(clampDragDelta('resize-end', -5, 10, 12)).toBe(-2);
    expect(clampDragDelta('resize-end', -1, 10, 12)).toBe(-1);
    expect(clampDragDelta('resize-end', 5, 10, 12)).toBe(5);
  });
});

describe('applyDrag', () => {
  it('move shifts both ends by the same delta, preserving duration', () => {
    expect(applyDrag({ start: 10, end: 15 }, 'move', 3)).toEqual({ start: 13, end: 18 });
  });

  it('resize-start only moves the start', () => {
    expect(applyDrag({ start: 10, end: 15 }, 'resize-start', 3)).toEqual({ start: 13, end: 15 });
  });

  it('resize-end only moves the end', () => {
    expect(applyDrag({ start: 10, end: 15 }, 'resize-end', -2)).toEqual({ start: 10, end: 13 });
  });
});

describe('dragValuesToPersist', () => {
  it('a zero delta persists nothing', () => {
    expect(dragValuesToPersist('move', 0, '2026-07-15', '2026-07-20')).toEqual({});
  });

  it('move persists both start and end when an end value exists', () => {
    expect(dragValuesToPersist('move', 2, '2026-07-15', '2026-07-20')).toEqual({
      start: '2026-07-17',
      end: '2026-07-22',
    });
  });

  it('move persists only start when there is no end value (a milestone)', () => {
    expect(dragValuesToPersist('move', 2, '2026-07-15', null)).toEqual({ start: '2026-07-17' });
  });

  it('resize-start persists only the start field', () => {
    expect(dragValuesToPersist('resize-start', -1, '2026-07-15', '2026-07-20')).toEqual({
      start: '2026-07-14',
    });
  });

  it('resize-end persists only the end field', () => {
    expect(dragValuesToPersist('resize-end', 4, '2026-07-15', '2026-07-20')).toEqual({
      end: '2026-07-24',
    });
  });

  it('preserves time-of-day through a persisted move', () => {
    expect(dragValuesToPersist('move', 1, '2026-07-15T08:00', '2026-07-15T17:00')).toEqual({
      start: '2026-07-16T08:00',
      end: '2026-07-16T17:00',
    });
  });
});

describe('dependencyEdges', () => {
  const row = (id: string, values: Record<string, unknown> = {}) => ({ id, values });

  it('resolves an edge from a blocked_by relation value', () => {
    const rows = [row('a'), row('b', { blocked_by: [{ id: 'a' }] })];
    expect(dependencyEdges(rows, 'blocked_by', undefined)).toEqual([{ blockerId: 'a', blockedId: 'b' }]);
  });

  it('resolves an edge from a blocker_for relation value', () => {
    const rows = [row('a', { blocker_for: [{ id: 'b' }] }), row('b')];
    expect(dependencyEdges(rows, undefined, 'blocker_for')).toEqual([{ blockerId: 'a', blockedId: 'b' }]);
  });

  it('dedupes when blocked_by and blocker_for describe the same pair (inverse relation sides)', () => {
    const rows = [row('a', { blocker_for: [{ id: 'b' }] }), row('b', { blocked_by: [{ id: 'a' }] })];
    expect(dependencyEdges(rows, 'blocked_by', 'blocker_for')).toEqual([{ blockerId: 'a', blockedId: 'b' }]);
  });

  it('drops an edge whose other end is not in the visible row set (off-screen/missing target)', () => {
    const rows = [row('b', { blocked_by: [{ id: 'off-screen-record' }] })];
    expect(dependencyEdges(rows, 'blocked_by', undefined)).toEqual([]);
  });

  it('ignores a self-referencing relation value', () => {
    const rows = [row('a', { blocked_by: [{ id: 'a' }] })];
    expect(dependencyEdges(rows, 'blocked_by', undefined)).toEqual([]);
  });

  it('returns nothing when neither relation field is present on the database', () => {
    const rows = [row('a'), row('b')];
    expect(dependencyEdges(rows, undefined, undefined)).toEqual([]);
  });

  it('handles multiple blockers for one record', () => {
    const rows = [row('a'), row('c'), row('b', { blocked_by: [{ id: 'a' }, { id: 'c' }] })];
    expect(dependencyEdges(rows, 'blocked_by', undefined)).toEqual([
      { blockerId: 'a', blockedId: 'b' },
      { blockerId: 'c', blockedId: 'b' },
    ]);
  });
});
