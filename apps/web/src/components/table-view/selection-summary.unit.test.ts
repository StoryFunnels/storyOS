import { describe, expect, it } from 'vitest';
import { computeTileValue } from '../views/dashboard-tiles';
import { SELECTION_OPS, formatSelectionValue, isFilled, isNumericField, summarizeSelection } from './selection-summary';

const num = (config: Record<string, unknown> = {}) => ({ type: 'number', config });
const text = { type: 'text', config: {} };

describe('#580 summarizeSelection — the same edge behaviour as a rollup', () => {
  it('sums, averages and bounds the numeric cells', () => {
    const f = num();
    const s = summarizeSelection([1, 2, 3, 6].map((value) => ({ field: f, value })));
    expect([s.count, s.sum, s.avg, s.min, s.max]).toEqual([4, 12, 3, 1, 6]);
  });

  it('is null (not 0) for sum/avg/min/max over no numeric cell, and count is 0 — a rollup over no rows', () => {
    const s = summarizeSelection([{ field: text, value: 'a' }]);
    expect([s.sum, s.avg, s.min, s.max]).toEqual([null, null, null, null]);
    const none = summarizeSelection([{ field: num(), value: null }]);
    expect(none.count).toBe(0);
    expect(none.sum).toBeNull();
    // and the em dash, never "0", is what is shown for them
    expect(formatSelectionValue(none, 'sum')).toBe('—');
    expect(formatSelectionValue(none, 'count')).toBe('0');
  });

  it('agrees with computeTileValue, the engine it reuses, for every op over the same cells', () => {
    const f = num();
    const values = [4, null, 2.5, '7', '', 'x'];
    const s = summarizeSelection(values.map((value) => ({ field: f, value })));
    const records = values.filter((v) => isFilled(v)).map((v) => ({ values: { v } }));
    for (const op of SELECTION_OPS) {
      if (op === 'count') continue;
      expect(s[op], op).toBe(computeTileValue(op, 'v', records));
    }
  });

  it('counts filled cells of ANY type but aggregates only number-bearing fields', () => {
    const s = summarizeSelection([
      { field: num(), value: 10 },
      { field: text, value: 'ten' },
      { field: text, value: '' },
      { field: { type: 'multi_select', config: {} }, value: [] },
      { field: { type: 'checkbox', config: {} }, value: false },
    ]);
    expect(s.cells).toBe(5);
    expect(s.count).toBe(3); // 10, 'ten', false — the blank text and empty list are not filled
    expect(s.sum).toBe(10);
  });

  it('keeps a numeric-looking string in a TEXT column out of the sum', () => {
    const s = summarizeSelection([
      { field: text, value: '5' },
      { field: num(), value: 1 },
    ]);
    expect(s.sum).toBe(1);
  });

  it('pools number cells across two number columns', () => {
    const s = summarizeSelection([
      { field: num(), value: 1 },
      { field: num({ format: 'percent' }), value: 3 },
    ]);
    expect(s.sum).toBe(4);
    expect(s.singleField).toBeNull();
  });
});

describe('#580 which fields take part', () => {
  it('number, a numeric formula, and a numeric rollup — not first/last/collect, not text', () => {
    expect(isNumericField(num())).toBe(true);
    expect(isNumericField({ type: 'formula', config: { result_type: 'number' } })).toBe(true);
    expect(isNumericField({ type: 'formula', config: { result_type: 'text' } })).toBe(false);
    expect(isNumericField({ type: 'rollup', config: { op: 'sum' } })).toBe(true);
    expect(isNumericField({ type: 'rollup', config: { op: 'collect' } })).toBe(false);
    expect(isNumericField({ type: 'rollup', config: { op: 'first' } })).toBe(false);
    expect(isNumericField(text)).toBe(false);
  });
});

describe('#580 formatSelectionValue', () => {
  it('shows one source column the way that column does, and drops float noise', () => {
    const f = num({ format: 'percent', precision: 1 });
    const s = summarizeSelection([0.1, 0.2].map((value) => ({ field: f, value })));
    expect(formatSelectionValue(s, 'sum')).toBe('0.3%');
  });

  it('uses a plain number across mixed columns', () => {
    const s = summarizeSelection([
      { field: num({ format: 'currency', currency_code: 'USD' }), value: 1 },
      { field: num(), value: 2 },
    ]);
    expect(formatSelectionValue(s, 'sum')).toBe('3');
  });
});
