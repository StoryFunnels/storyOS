import { describe, expect, it } from 'vitest';
import {
  computeTileValue,
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
