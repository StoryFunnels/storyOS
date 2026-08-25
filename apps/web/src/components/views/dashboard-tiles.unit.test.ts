import { describe, expect, it } from 'vitest';
import {
  computeTileValue,
  defaultBlockLabel,
  defaultTileLabel,
  formatTileValue,
  opNeedsField,
  toNumeric,
} from './dashboard-tiles';

const rec = (values: Record<string, unknown>) => ({ values });

describe('toNumeric', () => {
  it('accepts finite numbers', () => {
    expect(toNumeric(0)).toBe(0);
    expect(toNumeric(-3.5)).toBe(-3.5);
  });
  it('accepts numeric strings, trimming whitespace', () => {
    expect(toNumeric('12')).toBe(12);
    expect(toNumeric('  4.25 ')).toBe(4.25);
  });
  it('rejects non-numeric, blank, boolean, object, and non-finite values', () => {
    expect(toNumeric('')).toBeNull();
    expect(toNumeric('  ')).toBeNull();
    expect(toNumeric('abc')).toBeNull();
    expect(toNumeric(true)).toBeNull();
    expect(toNumeric(null)).toBeNull();
    expect(toNumeric(undefined)).toBeNull();
    expect(toNumeric({})).toBeNull();
    expect(toNumeric(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toNumeric(Number.NaN)).toBeNull();
  });
});

describe('opNeedsField', () => {
  it('is false only for count', () => {
    expect(opNeedsField('count')).toBe(false);
    expect(opNeedsField('sum')).toBe(true);
    expect(opNeedsField('avg')).toBe(true);
    expect(opNeedsField('min')).toBe(true);
    expect(opNeedsField('max')).toBe(true);
  });
});

describe('computeTileValue', () => {
  const rows = [
    rec({ amount: 10, stage: 'won' }),
    rec({ amount: 20, stage: 'lost' }),
    rec({ amount: '30', stage: 'won' }), // numeric string counts
    rec({ amount: null, stage: 'won' }), // skipped by numeric ops
    rec({ stage: 'won' }), // missing field, skipped
  ];

  it('count returns the record count and ignores the field', () => {
    expect(computeTileValue('count', undefined, rows)).toBe(5);
    expect(computeTileValue('count', 'amount', rows)).toBe(5);
    expect(computeTileValue('count', undefined, [])).toBe(0);
  });

  it('sum adds numeric values, skipping null/missing/non-numeric', () => {
    expect(computeTileValue('sum', 'amount', rows)).toBe(60);
  });

  it('avg divides by the count of numeric values only', () => {
    expect(computeTileValue('avg', 'amount', rows)).toBe(20); // (10+20+30)/3
  });

  it('min and max ignore non-numeric rows', () => {
    expect(computeTileValue('min', 'amount', rows)).toBe(10);
    expect(computeTileValue('max', 'amount', rows)).toBe(30);
  });

  it('numeric ops return null when no record has a numeric value (SQL semantics)', () => {
    const noNums = [rec({ amount: null }), rec({ stage: 'x' })];
    expect(computeTileValue('sum', 'amount', noNums)).toBeNull();
    expect(computeTileValue('avg', 'amount', noNums)).toBeNull();
    expect(computeTileValue('min', 'amount', noNums)).toBeNull();
    expect(computeTileValue('max', 'amount', noNums)).toBeNull();
  });

  it('numeric ops return null when the tile has no target field', () => {
    expect(computeTileValue('sum', undefined, rows)).toBeNull();
  });
});

describe('defaultTileLabel', () => {
  it('labels count generically', () => {
    expect(defaultTileLabel('count')).toBe('Count of records');
  });
  it('labels numeric ops with the field display name', () => {
    expect(defaultTileLabel('sum', 'Amount')).toBe('Sum of Amount');
    expect(defaultTileLabel('avg', 'Score')).toBe('Avg of Score');
  });
  it('falls back when the field name is unknown', () => {
    expect(defaultTileLabel('max')).toBe('Max of field');
  });
});

describe('formatTileValue', () => {
  it('renders null as an em dash', () => {
    expect(formatTileValue(null)).toBe('—');
  });
  it('keeps integers integer and groups thousands', () => {
    expect(formatTileValue(1234)).toBe((1234).toLocaleString());
    expect(formatTileValue(0)).toBe('0');
  });
  it('rounds fractions to 2 decimals', () => {
    expect(formatTileValue(3.14159)).toBe((3.14).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  });
});

/**
 * #387 — the founder's dashboard showed two tiles both headed "Count of records",
 * reading 383 and 5. The only way to tell them apart was the database dropdown in
 * the editor beneath each, which #385's view mode hides. These assertions are the
 * reason the two tickets ship together.
 */
describe('defaultBlockLabel (#387)', () => {
  it('distinguishes two count tiles over different databases — the actual bug', () => {
    const issues = defaultBlockLabel({ sourceName: 'Issues', op: 'count' });
    const docs = defaultBlockLabel({ sourceName: 'Docs', op: 'count' });
    expect(issues).toBe('Issues · Count');
    expect(docs).toBe('Docs · Count');
    // The whole point: they must not read the same.
    expect(issues).not.toBe(docs);
  });

  it('leads with the database, because that is the distinguishing part', () => {
    // "Count of records" repeats across every count tile; the source does not.
    expect(defaultBlockLabel({ sourceName: 'Invoices', op: 'count' })).toMatch(/^Invoices/);
  });

  it('names the measured field for a numeric op', () => {
    expect(
      defaultBlockLabel({ sourceName: 'Invoices', op: 'sum', fieldDisplayName: 'Amount' }),
    ).toBe('Invoices · Sum of Amount');
  });

  it('falls back to "field" when the field name is unknown rather than printing an api_name', () => {
    expect(defaultBlockLabel({ sourceName: 'Invoices', op: 'avg' })).toBe('Invoices · Avg of field');
  });

  it('reads as "<measure> by <group>" for a chart', () => {
    expect(
      defaultBlockLabel({ sourceName: 'Tasks', op: 'count', groupByDisplayName: 'State' }),
    ).toBe('Tasks · Count by State');
  });

  it('combines a numeric measure with a group-by', () => {
    expect(
      defaultBlockLabel({
        sourceName: 'Clients',
        op: 'sum',
        fieldDisplayName: 'Monthly Value',
        groupByDisplayName: 'Industry',
      }),
    ).toBe('Clients · Sum of Monthly Value by Industry');
  });

  /**
   * #305 / #387 — a tile with no configured source must not get a confident
   * label. Returning null makes the caller render its unconfigured state, which
   * is what stops a bare 0 from reading as a real answer.
   */
  it('returns null when there is no source to name', () => {
    expect(defaultBlockLabel({ op: 'count' })).toBeNull();
    expect(defaultBlockLabel({ sourceName: '', op: 'count' })).toBeNull();
  });
});
