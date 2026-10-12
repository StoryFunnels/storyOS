import { describe, expect, it } from 'vitest';
import {
  EMPTY_GROUP_LABEL,
  computeChartSeries,
  dateDayKey,
  groupKeysForRecord,
  measureNeedsField,
  seriesFromGroups,
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

/**
 * #795 — the widget moves from reducing records in the browser to reading the server's
 * per-group measure. The claim is that nothing a person sees changes, so this does not
 * restate expectations: it feeds the SAME records to the old reducer and, key for key,
 * to a stand-in for the endpoint (group by `groupKeysForRecord`, then measure), and
 * requires the two series to match. Marek's API tests do the other half of that
 * comparison against the real endpoint.
 */
describe('seriesFromGroups parity with computeChartSeries (#795)', () => {
  const serverGroups = (
    records: Array<{ values: Record<string, unknown> }>,
    field: string,
    type: string,
    sumField?: string,
  ) => {
    const buckets = new Map<string | null, number[]>();
    for (const r of records) {
      for (const k of groupKeysForRecord(r.values[field], type)) {
        const list = buckets.get(k) ?? [];
        if (sumField) list.push(Number(r.values[sumField] ?? 0));
        else list.push(1);
        buckets.set(k, list);
      }
    }
    return [...buckets].map(([key, nums]) => ({ key, value: nums.reduce((a, b) => a + b, 0) }));
  };
  const labelFor = (k: string) => ({ a: 'Alpha', b: 'Beta', c: 'Gamma', true: 'Yes', false: 'No' })[k] ?? k;
  const view = (pts: Array<{ key: string | null; label: string; value: number | null }>) =>
    pts.map((p) => [p.key, p.label, p.value]);

  it('multi_select: a record counts in each option, so the groups sum to more than the records', () => {
    const records = [
      rec({ tags: ['a', 'b'], amount: 5 }),
      rec({ tags: ['a'], amount: 2 }),
      rec({ tags: ['a', 'b', 'c'], amount: 7 }),
      rec({ tags: [], amount: 1 }),
      rec({ amount: 4 }),
    ];
    const old = computeChartSeries(records, 'tags', 'multi_select', { op: 'count' }, labelFor);
    const next = seriesFromGroups(serverGroups(records, 'tags', 'multi_select'), 'count', labelFor);
    expect(view(next)).toEqual(view(old));
    expect(next.reduce((n, p) => n + (p.value ?? 0), 0)).toBeGreaterThan(records.length);
    expect(next.at(-1)?.key).toBeNull(); // the empty bucket stays last
  });

  it('checkbox: Yes / No / empty, with the empty bucket last', () => {
    const records = [rec({ done: true }), rec({ done: true }), rec({ done: false }), rec({})];
    const old = computeChartSeries(records, 'done', 'checkbox', { op: 'count' }, labelFor);
    const next = seriesFromGroups(serverGroups(records, 'done', 'checkbox'), 'count', labelFor);
    expect(view(next)).toEqual(view(old));
    expect(next.map((p) => p.label)).toEqual(['Yes', 'No', EMPTY_GROUP_LABEL]);
  });

  it('a sum measure orders by value and keeps the empty bucket last', () => {
    const records = [rec({ s: 'a', amount: 3 }), rec({ s: 'b', amount: 9 }), rec({ s: 'a', amount: 4 }), rec({ amount: 100 })];
    const old = computeChartSeries(records, 's', 'select', { op: 'sum', field_api_name: 'amount' }, labelFor);
    const next = seriesFromGroups(serverGroups(records, 's', 'select', 'amount'), 'sum', labelFor);
    expect(view(next)).toEqual(view(old));
    expect(next.map((p) => p.key)).toEqual(['b', 'a', null]);
  });

  it('an empty result is an empty series, not a crash', () => {
    expect(seriesFromGroups([], 'count', labelFor)).toEqual([]);
  });

  // The one deliberate difference, pinned: the server returns no per-group record count.
  it('count is the measure only for the count op', () => {
    expect(seriesFromGroups([{ key: 'a', value: 7 }], 'count')[0]?.count).toBe(7);
    expect(seriesFromGroups([{ key: 'a', value: 7 }], 'sum')[0]?.count).toBe(0);
  });
});
