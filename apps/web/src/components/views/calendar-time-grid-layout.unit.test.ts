import { describe, expect, it } from 'vitest';
import { layoutDayEvents, parseDateValue, shiftDateValue, splitTimedEventAcrossDays } from './calendar-time-grid-layout';
import type { TimedEvent } from './calendar-time-grid-layout';

describe('parseDateValue — all-day vs timed (#470 AC5)', () => {
  it('a bare YYYY-MM-DD is all-day: minutes is null, never 0', () => {
    expect(parseDateValue('2026-03-15')).toEqual({ dayKey: '2026-03-15', minutes: null });
  });

  it('a datetime extracts the local day and minutes-since-midnight', () => {
    const result = parseDateValue('2026-03-15T09:30:00');
    expect(result.dayKey).toBe('2026-03-15');
    expect(result.minutes).toBe(9 * 60 + 30);
  });

  it('midnight-exactly is still a real timed value (00:00), distinguishable from all-day (null)', () => {
    const result = parseDateValue('2026-03-15T00:00:00');
    expect(result.minutes).toBe(0);
    expect(result.minutes).not.toBeNull();
  });
});

describe('layoutDayEvents — overlap columns (#470 AC4)', () => {
  const ev = (id: string, startMinutes: number, endMinutes: number): TimedEvent => ({ id, startMinutes, endMinutes });

  it('a single event gets one column', () => {
    const layout = layoutDayEvents([ev('a', 0, 60)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 1 });
  });

  it('two non-overlapping events each get their own full-width column', () => {
    const layout = layoutDayEvents([ev('a', 0, 60), ev('b', 60, 120)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 1 });
    expect(layout.get('b')).toEqual({ col: 0, cols: 1 });
  });

  it('two directly-overlapping events split into two side-by-side columns', () => {
    const layout = layoutDayEvents([ev('a', 0, 60), ev('b', 30, 90)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 2 });
    expect(layout.get('b')).toEqual({ col: 1, cols: 2 });
  });

  it('a third event starting after the cluster fully closes gets its own fresh cluster', () => {
    const layout = layoutDayEvents([ev('a', 0, 60), ev('b', 30, 90), ev('c', 100, 120)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 2 });
    expect(layout.get('b')).toEqual({ col: 1, cols: 2 });
    expect(layout.get('c')).toEqual({ col: 0, cols: 1 });
  });

  it('a transitive chain (A-B overlap, B-C overlap, A-C do not) shares one cluster of 2 columns, not 3', () => {
    // A[0,60) B[30,90) C[80,120) — B touches both, A and C never touch each other.
    const layout = layoutDayEvents([ev('a', 0, 60), ev('b', 30, 90), ev('c', 80, 120)]);
    expect(layout.get('a')!.cols).toBe(2);
    expect(layout.get('b')!.cols).toBe(2);
    expect(layout.get('c')!.cols).toBe(2);
    // A and C can share a column (they never overlap each other); B must differ from both.
    expect(layout.get('a')!.col).toBe(layout.get('c')!.col);
    expect(layout.get('b')!.col).not.toBe(layout.get('a')!.col);
  });

  it('three mutually-overlapping events need three columns', () => {
    const layout = layoutDayEvents([ev('a', 0, 90), ev('b', 30, 90), ev('c', 60, 120)]);
    expect(new Set([layout.get('a')!.col, layout.get('b')!.col, layout.get('c')!.col]).size).toBe(3);
    expect(layout.get('a')!.cols).toBe(3);
  });

  it('is empty for no events', () => {
    expect(layoutDayEvents([]).size).toBe(0);
  });
});

describe('splitTimedEventAcrossDays — multi-day span rendering (#471 AC2)', () => {
  it('a same-day event produces exactly one segment, unchanged from start to end', () => {
    const spans = splitTimedEventAcrossDays('2026-03-15', 540, '2026-03-15', 600, [
      '2026-03-14',
      '2026-03-15',
      '2026-03-16',
    ]);
    expect(spans).toEqual([
      { dayKey: '2026-03-15', startMinutes: 540, endMinutes: 600, continuesFromPrevDay: false, continuesToNextDay: false },
    ]);
  });

  it('a two-day span gets a segment on each day: real start to midnight, then midnight to real end', () => {
    const spans = splitTimedEventAcrossDays('2026-03-15', 540, '2026-03-16', 120, [
      '2026-03-15',
      '2026-03-16',
    ]);
    expect(spans).toEqual([
      { dayKey: '2026-03-15', startMinutes: 540, endMinutes: 1440, continuesFromPrevDay: false, continuesToNextDay: true },
      { dayKey: '2026-03-16', startMinutes: 0, endMinutes: 120, continuesFromPrevDay: true, continuesToNextDay: false },
    ]);
  });

  it('a three-day span gives the middle day a full 0-1440 segment', () => {
    const spans = splitTimedEventAcrossDays('2026-03-15', 540, '2026-03-17', 120, [
      '2026-03-15',
      '2026-03-16',
      '2026-03-17',
    ]);
    expect(spans.map((s) => s.dayKey)).toEqual(['2026-03-15', '2026-03-16', '2026-03-17']);
    expect(spans[1]).toEqual({ dayKey: '2026-03-16', startMinutes: 0, endMinutes: 1440, continuesFromPrevDay: true, continuesToNextDay: true });
  });

  it('clips to the visible window: a span extending past the displayed days only yields visible segments', () => {
    const spans = splitTimedEventAcrossDays('2026-03-10', 0, '2026-03-20', 0, ['2026-03-15', '2026-03-16']);
    expect(spans.map((s) => s.dayKey)).toEqual(['2026-03-15', '2026-03-16']);
    expect(spans[0]!.continuesFromPrevDay).toBe(true);
    expect(spans[1]!.continuesToNextDay).toBe(true);
  });

  it('is empty when the span never touches any visible day', () => {
    expect(splitTimedEventAcrossDays('2026-01-01', 0, '2026-01-02', 0, ['2026-03-15'])).toEqual([]);
  });
});

describe('shiftDateValue — drag-to-reschedule write-back (#470 AC2/AC8)', () => {
  it('shifts a datetime by minutes within the same day', () => {
    expect(shiftDateValue('2026-03-15T09:00:00', 0, 30)).toBe('2026-03-15T09:30:00');
  });

  it('shifts a datetime across a day boundary (week mode horizontal drag)', () => {
    expect(shiftDateValue('2026-03-15T09:00:00', 2, 0)).toBe('2026-03-17T09:00:00');
  });

  it('a bare date shifted by days stays a bare date — dragging never invents a time', () => {
    expect(shiftDateValue('2026-03-15', 1, 0)).toBe('2026-03-16');
  });

  it('a negative delta moves earlier, including across midnight', () => {
    expect(shiftDateValue('2026-03-15T00:20:00', 0, -30)).toBe('2026-03-14T23:50:00');
  });
});
