import { describe, expect, it } from 'vitest';
import {
  EMPTY_GROUP_LABEL,
  computeChartSeries,
  dateDayKey,
  groupKeysForRecord,
  measureNeedsField,
} from './dashboard-charts';

const rec = (values: Record<string, unknown>) => ({ values });

describe('dateDayKey', () => {
  it('buckets an ISO timestamp to its UTC calendar day', () => {
    expect(dateDayKey('2026-07-29T13:45:00.000Z')).toBe('2026-07-29');
    expect(dateDayKey('2026-01-02')).toBe('2026-01-02');
  });
  it('returns null for empty / invalid dates', () => {
    expect(dateDayKey('')).toBeNull();
    expect(dateDayKey(null)).toBeNull();
    expect(dateDayKey(undefined)).toBeNull();
    expect(dateDayKey('not-a-date')).toBeNull();
  });
});

describe('groupKeysForRecord', () => {
  it('returns [null] for empty scalar values', () => {
    expect(groupKeysForRecord(null, 'select')).toEqual([null]);
    expect(groupKeysForRecord(undefined, 'select')).toEqual([null]);
    expect(groupKeysForRecord('', 'select')).toEqual([null]);
  });
  it('stringifies a scalar select value', () => {
    expect(groupKeysForRecord('opt-1', 'select')).toEqual(['opt-1']);
  });
  it('spreads a multi_select array into one key per element', () => {
    expect(groupKeysForRecord(['a', 'b'], 'multi_select')).toEqual(['a', 'b']);
  });
  it('treats an empty array as the empty bucket', () => {
    expect(groupKeysForRecord([], 'multi_select')).toEqual([null]);
  });
  it('buckets date fields to the day', () => {
    expect(groupKeysForRecord('2026-07-29T09:00:00Z', 'date')).toEqual(['2026-07-29']);
  });
  it('maps booleans to true/false keys', () => {
    expect(groupKeysForRecord(true, 'checkbox')).toEqual(['true']);
    expect(groupKeysForRecord(false, 'checkbox')).toEqual(['false']);
  });
});

describe('measureNeedsField', () => {
  it('is false only for count', () => {
    expect(measureNeedsField('count')).toBe(false);
    expect(measureNeedsField('sum')).toBe(true);
    expect(measureNeedsField('avg')).toBe(true);
  });
});

describe('computeChartSeries', () => {
  it('returns [] when no group-by field is set', () => {
    expect(computeChartSeries([rec({ stage: 'a' })], undefined, 'select', { op: 'count' })).toEqual(
      [],
    );
  });

  it('counts records per group, sorted by descending value', () => {
    const rows = [
      rec({ stage: 'won' }),
      rec({ stage: 'won' }),
      rec({ stage: 'lost' }),
      rec({ stage: 'open' }),
      rec({ stage: 'won' }),
    ];
    const series = computeChartSeries(rows, 'stage', 'select', { op: 'count' });
    expect(series.map((p) => [p.key, p.value])).toEqual([
      ['won', 3],
      ['lost', 1],
      ['open', 1],
    ]);
  });

  it('sums a numeric measure field per group', () => {
    const rows = [
      rec({ stage: 'won', amount: 100 }),
      rec({ stage: 'won', amount: '50' }),
      rec({ stage: 'lost', amount: 30 }),
    ];
    const series = computeChartSeries(rows, 'stage', 'select', {
      op: 'sum',
      field_api_name: 'amount',
    });
    expect(series).toEqual([
      { key: 'won', label: 'won', value: 150, count: 2 },
      { key: 'lost', label: 'lost', value: 30, count: 1 },
    ]);
  });

  it('averages, and returns null value for a group with no numeric values', () => {
    const rows = [
      rec({ stage: 'won', amount: 10 }),
      rec({ stage: 'won', amount: 20 }),
      rec({ stage: 'lost', amount: null }),
    ];
    const series = computeChartSeries(rows, 'stage', 'select', {
      op: 'avg',
      field_api_name: 'amount',
    });
    const won = series.find((p) => p.key === 'won');
    const lost = series.find((p) => p.key === 'lost');
    expect(won?.value).toBe(15);
    expect(lost?.value).toBeNull();
    expect(lost?.count).toBe(1);
  });

  it('resolves labels via labelFor and puts the empty bucket last', () => {
    const rows = [
      rec({ stage: 'opt-1' }),
      rec({ stage: null }),
      rec({ stage: 'opt-1' }),
      rec({ stage: 'opt-2' }),
    ];
    const labelFor = (k: string) => ({ 'opt-1': 'Won', 'opt-2': 'Lost' })[k] ?? k;
    const series = computeChartSeries(rows, 'stage', 'select', { op: 'count' }, labelFor);
    expect(series.map((p) => p.label)).toEqual(['Won', 'Lost', EMPTY_GROUP_LABEL]);
    expect(series[series.length - 1]!.key).toBeNull();
  });

  it('spreads multi_select records across every selected group', () => {
    const rows = [rec({ tags: ['a', 'b'] }), rec({ tags: ['a'] }), rec({ tags: [] })];
    const series = computeChartSeries(rows, 'tags', 'multi_select', { op: 'count' });
    expect(series.find((p) => p.key === 'a')?.value).toBe(2);
    expect(series.find((p) => p.key === 'b')?.value).toBe(1);
    expect(series.find((p) => p.key === null)?.value).toBe(1);
  });

  it('sorts date group-bys chronologically, not by value', () => {
    const rows = [
      rec({ closed: '2026-03-01' }),
      rec({ closed: '2026-01-01' }),
      rec({ closed: '2026-01-01' }),
      rec({ closed: '2026-02-01' }),
    ];
    const series = computeChartSeries(rows, 'closed', 'date', { op: 'count' });
    expect(series.map((p) => p.key)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(series[0]!.value).toBe(2);
  });
});
