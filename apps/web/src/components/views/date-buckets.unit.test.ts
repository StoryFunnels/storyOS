import { describe, expect, it } from 'vitest';
import {
  bucketColumnsFor,
  bucketLabel,
  bucketStartISO,
  dateBucketKey,
  isDateGranularity,
} from './date-buckets';

describe('dateBucketKey', () => {
  it('buckets by year / quarter / month', () => {
    expect(dateBucketKey('2026-08-12', 'year')).toBe('2026');
    expect(dateBucketKey('2026-08-12', 'quarter')).toBe('2026-Q3');
    expect(dateBucketKey('2026-08-12', 'month')).toBe('2026-08');
  });

  it('maps every month to the right quarter, including the boundaries', () => {
    const q = (m: string) => dateBucketKey(`2026-${m}-15`, 'quarter');
    expect([q('01'), q('03')]).toEqual(['2026-Q1', '2026-Q1']);
    expect([q('04'), q('06')]).toEqual(['2026-Q2', '2026-Q2']);
    expect([q('07'), q('09')]).toEqual(['2026-Q3', '2026-Q3']);
    expect([q('10'), q('12')]).toEqual(['2026-Q4', '2026-Q4']);
  });

  it('buckets a week to its Monday', () => {
    // 2026-08-12 is a Wednesday; its ISO week starts Monday 2026-08-10.
    expect(dateBucketKey('2026-08-12', 'week')).toBe('2026-W08-10');
    expect(dateBucketKey('2026-08-10', 'week')).toBe('2026-W08-10');
    // Sunday belongs to the week that STARTED on the previous Monday.
    expect(dateBucketKey('2026-08-16', 'week')).toBe('2026-W08-10');
    // Monday the 17th opens a new bucket.
    expect(dateBucketKey('2026-08-17', 'week')).toBe('2026-W08-17');
  });

  it('handles a week spanning a year boundary without inventing a week 53 problem', () => {
    // 2026-01-01 is a Thursday → its week started Monday 2025-12-29.
    expect(dateBucketKey('2026-01-01', 'week')).toBe('2025-W12-29');
    expect(dateBucketKey('2025-12-29', 'week')).toBe('2025-W12-29');
  });

  it('returns null for empty / unparseable values so they land in "No date"', () => {
    for (const bad of [null, undefined, '', 'not-a-date', {}, []]) {
      expect(dateBucketKey(bad, 'month')).toBeNull();
    }
  });

  it('is timezone-stable: an instant buckets by its UTC date', () => {
    expect(dateBucketKey('2026-08-12T23:30:00.000Z', 'month')).toBe('2026-08');
    expect(dateBucketKey('2026-09-01T00:30:00.000Z', 'month')).toBe('2026-09');
  });
});

describe('bucketStartISO — what a drag writes back', () => {
  it('returns the first day of the period', () => {
    expect(bucketStartISO('2026', 'year')).toBe('2026-01-01');
    expect(bucketStartISO('2026-Q1', 'quarter')).toBe('2026-01-01');
    expect(bucketStartISO('2026-Q3', 'quarter')).toBe('2026-07-01');
    expect(bucketStartISO('2026-Q4', 'quarter')).toBe('2026-10-01');
    expect(bucketStartISO('2026-08', 'month')).toBe('2026-08-01');
    expect(bucketStartISO('2026-W08-10', 'week')).toBe('2026-08-10');
  });

  /**
   * The load-bearing property: dropping a card into a column and re-bucketing the
   * value it wrote must land in the SAME column. Without this a card could jump
   * columns the instant it was dropped.
   */
  it('round-trips — the written date re-buckets to the same key', () => {
    for (const g of ['year', 'quarter', 'month', 'week'] as const) {
      for (const sample of ['2026-01-01', '2026-08-12', '2026-12-31', '2025-12-29']) {
        const key = dateBucketKey(sample, g)!;
        const written = bucketStartISO(key, g)!;
        expect(dateBucketKey(written, g), `${g} ${sample}`).toBe(key);
      }
    }
  });

  it('returns null for a malformed key rather than a bogus date', () => {
    expect(bucketStartISO('nonsense', 'month')).toBeNull();
    expect(bucketStartISO('2026-Q9', 'quarter')).toBeNull();
    expect(bucketStartISO('26-08', 'month')).toBeNull();
  });
});

describe('bucketLabel', () => {
  it('reads naturally per granularity', () => {
    expect(bucketLabel('2026', 'year')).toBe('2026');
    expect(bucketLabel('2026-Q3', 'quarter')).toBe('Q3 2026');
    expect(bucketLabel('2026-08', 'month')).toBe('Aug 2026');
    expect(bucketLabel('2026-08-10', 'month')).toBe('Aug 2026');
    expect(bucketLabel('2026-W08-10', 'week')).toBe('Week of Aug 10, 2026');
  });

  it('falls back to the raw key instead of throwing on nonsense', () => {
    expect(bucketLabel('garbage', 'quarter')).toBe('garbage');
  });
});

describe('bucketColumnsFor', () => {
  it('returns each present bucket once, chronologically', () => {
    const values = ['2026-03-02', '2026-01-15', '2026-03-28', '2025-11-02'];
    expect(bucketColumnsFor(values, 'month')).toEqual(['2025-11', '2026-01', '2026-03']);
  });

  it('omits empty/invalid values (they belong to the No-date column, not a bucket)', () => {
    expect(bucketColumnsFor(['2026-01-15', null, '', 'bad'], 'month')).toEqual(['2026-01']);
  });

  it('does not emit gap columns between distant records', () => {
    // Two records three years apart must not produce 36 empty month columns.
    expect(bucketColumnsFor(['2024-01-05', '2027-01-05'], 'month')).toEqual(['2024-01', '2027-01']);
  });

  it('sorts quarters and weeks chronologically as strings', () => {
    expect(bucketColumnsFor(['2026-10-01', '2026-02-01'], 'quarter')).toEqual(['2026-Q1', '2026-Q4']);
    expect(bucketColumnsFor(['2026-08-17', '2026-08-10'], 'week')).toEqual([
      '2026-W08-10',
      '2026-W08-17',
    ]);
  });
});

describe('isDateGranularity', () => {
  it('accepts the four supported values and nothing else', () => {
    for (const g of ['week', 'month', 'quarter', 'year']) expect(isDateGranularity(g)).toBe(true);
    for (const bad of ['day', 'decade', '', null, undefined, 7]) {
      expect(isDateGranularity(bad)).toBe(false);
    }
  });
});
