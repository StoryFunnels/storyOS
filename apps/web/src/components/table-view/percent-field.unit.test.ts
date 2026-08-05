import { describe, expect, it } from 'vitest';
import { isPercentField, isPercentNumberField } from './cell-text';

// #190: a number formula marked percent renders as a progress bar, just like a
// percent-formatted number field — but only when the result is actually a number.
describe('#190 isPercentField — percent progress-bar gate', () => {
  it('is true for a percent-formatted number field', () => {
    expect(isPercentField({ type: 'number', config: { format: 'percent' } })).toBe(true);
    expect(isPercentNumberField({ type: 'number', config: { format: 'percent' } })).toBe(true);
  });

  it('is true for a number-result formula marked percent', () => {
    expect(
      isPercentField({ type: 'formula', config: { result_type: 'number', format: 'percent' } }),
    ).toBe(true);
  });

  it('is false for a percent-marked formula whose result is NOT a number', () => {
    expect(
      isPercentField({ type: 'formula', config: { result_type: 'text', format: 'percent' } }),
    ).toBe(false);
  });

  it('is false for a number formula without percent format', () => {
    expect(isPercentField({ type: 'formula', config: { result_type: 'number' } })).toBe(false);
  });

  it('is false for a plain number field, and formula percent is NOT a "number field"', () => {
    expect(isPercentField({ type: 'number', config: {} })).toBe(false);
    expect(
      isPercentNumberField({ type: 'formula', config: { result_type: 'number', format: 'percent' } }),
    ).toBe(false);
  });
});
