import { describe, expect, it } from 'vitest';
import { evaluateFormula, FormulaError, formulaRefs, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';

const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'estimate', display_name: 'Estimate', formula_type: 'number' },
  { api_name: 'spent', display_name: 'Spent', formula_type: 'number' },
  { api_name: 'state', display_name: 'State', formula_type: 'text' },
  { api_name: 'due', display_name: 'Due', formula_type: 'date' },
  { api_name: 'urgent', display_name: 'Urgent', formula_type: 'checkbox' },
];

const evalSrc = (src: string, values: Record<string, unknown> = {}) =>
  evaluateFormula(parseFormula(src, FIELDS), values);

describe('formula engine (MN-043)', () => {
  it('handles precedence, refs, and arithmetic', () => {
    expect(evalSrc('{Estimate} - {Spent} * 2', { estimate: 10, spent: 3 })).toBe(4);
    expect(evalSrc('({Estimate} - {Spent}) * 2', { estimate: 10, spent: 3 })).toBe(14);
    expect(typecheck(parseFormula('{Estimate} - {Spent}', FIELDS), FIELDS)).toBe('number');
  });

  it('null propagates; division by zero is null', () => {
    expect(evalSrc('{Estimate} * 2', {})).toBe(null);
    expect(evalSrc('{Estimate} / 0', { estimate: 4 })).toBe(null);
    expect(evalSrc('coalesce({Estimate}, 0) + 1', {})).toBe(1);
  });

  it('if() over text with comparisons and logic', () => {
    const src = 'if({State} == "Done" and not {Urgent}, "rest", "work")';
    expect(evalSrc(src, { state: 'Done', urgent: false })).toBe('rest');
    expect(evalSrc(src, { state: 'Done', urgent: true })).toBe('work');
    expect(typecheck(parseFormula(src, FIELDS), FIELDS)).toBe('text');
  });

  it('date math', () => {
    expect(evalSrc('days_between("2026-07-01", {Due})', { due: '2026-07-11' })).toBe(10);
    expect(evalSrc('add_days({Due}, 3)', { due: '2026-07-01' })).toBe('2026-07-04');
    expect(evalSrc('year({Due})', { due: '2026-07-01' })).toBe(2026);
  });

  it('text functions and + concatenation', () => {
    expect(evalSrc('upper(concat({State}, "!"))', { state: 'done' })).toBe('DONE!');
    expect(evalSrc('"Task: " + {State}', { state: 'Open' })).toBe('Task: Open');
    expect(evalSrc('replace("a b c", " ", "-")')).toBe('a-b-c');
    expect(evalSrc('round(10 / 3, 2)')).toBe(3.33);
  });

  it('reports typed errors with positions', () => {
    expect(() => parseFormula('{Nope} + 1', FIELDS)).toThrow(FormulaError);
    expect(() => parseFormula('bogus(1)', FIELDS)).toThrow(/Unknown function/);
    expect(() => typecheck(parseFormula('{State} * 2', FIELDS), FIELDS)).toThrow(/needs numbers/);
    expect(() => typecheck(parseFormula('if({Estimate}, 1, 2)', FIELDS), FIELDS)).toThrow(/condition/);
    expect(() => typecheck(parseFormula('if({Urgent}, 1, "x")', FIELDS), FIELDS)).toThrow(/same type/);
  });

  it('collects refs for dependency analysis', () => {
    expect(formulaRefs(parseFormula('if({Urgent}, {Estimate}, {Spent})', FIELDS)).sort()).toEqual([
      'estimate', 'spent', 'urgent',
    ]);
  });
});
