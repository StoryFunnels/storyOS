import { describe, expect, it } from 'vitest';
import { FormulaError, formulaErrorToDiagnostic, nearestName, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';

/**
 * ticket #1263 — a formula error a MODEL can act on: where (start/end offsets), what was expected, what was found, and the nearest
 * valid name. The cases below are the ones an agent actually produces: a mistyped field, a mistyped function, a wrong argument type,
 * an unbalanced parenthesis.
 */
const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'qty', display_name: 'Qty', formula_type: 'number' },
  { api_name: 'unit_price', display_name: 'Unit Price', formula_type: 'number' },
  { api_name: 'name', display_name: 'Name', formula_type: 'text' },
  { api_name: 'urgent', display_name: 'Urgent', formula_type: 'checkbox' },
];

function diagnose(src: string) {
  try {
    typecheck(parseFormula(src, FIELDS), FIELDS);
  } catch (e) {
    if (e instanceof FormulaError) return formulaErrorToDiagnostic(e, src);
    throw e;
  }
  throw new Error(`expected "${src}" to be rejected`);
}

describe('formula diagnostics (#1263)', () => {
  it('unknown field: positions the reference and suggests the nearest field by edit distance', () => {
    const d = diagnose('{Unit Prise} * {Qty}');
    expect(d.position).toEqual({ start: 0, end: 12 });
    expect(d.suggestion).toBe('{Unit Price}');
    expect(d.got).toBe('Unit Prise');
    expect(d.expected).toMatch(/field/);
  });

  it('unknown field with nothing close: NO suggestion (a wrong confident suggestion is worse than none)', () => {
    const d = diagnose('{Completely Unrelated}');
    expect(d.suggestion).toBeNull();
    expect(d.position).toEqual({ start: 0, end: 22 });
  });

  it('unknown function: positions the name and suggests the nearest function', () => {
    const d = diagnose('rond({Qty}, 2)');
    expect(d.position).toEqual({ start: 0, end: 4 });
    expect(d.suggestion).toBe('round');
    expect(d.message).toMatch(/did you mean round\(\)/);
  });

  it('wrong argument type: points at the ARGUMENT and says expected vs got', () => {
    const d = diagnose('round({Name}, 2)');
    expect(d.position).toEqual({ start: 6, end: 12 });
    expect(d.expected).toBe('number');
    expect(d.got).toBe('text');
    expect(d.suggestion).toMatch(/to_number/);
  });

  it('an operator type error is positioned on the whole operation, with both operand types', () => {
    const d = diagnose('{Qty} + 1 - {Name}');
    // innermost failing node: the `-`, spanning the whole expression (the `+` below it is fine)
    expect(d.position).toEqual({ start: 0, end: 18 });
    expect(d.got).toBe('number and text');
    expect(d.expected).toMatch(/number/);
  });

  it('a type error deep inside a call is positioned on the inner node, not the call', () => {
    const d = diagnose('if({Urgent}, {Qty} * {Name}, 0)');
    expect(d.position.start).toBe(13);
    expect(d.position.end).toBe(27);
    expect('if({Urgent}, {Qty} * {Name}, 0)'.slice(d.position.start, d.position.end)).toBe('{Qty} * {Name}');
  });

  it('unbalanced parenthesis: says so, and points at the end of the input', () => {
    const src = 'round({Qty}, 2';
    const d = diagnose(src);
    expect(d.message).toMatch(/Missing closing parenthesis/);
    expect(d.position).toEqual({ start: src.length, end: src.length });
    expect(d.expected).toBe(')');
    expect(d.suggestion).toMatch(/\)/);
  });

  it('a stray closing parenthesis is reported at that parenthesis', () => {
    const d = diagnose('{Qty} + 1)');
    expect(d.position).toEqual({ start: 9, end: 10 });
    expect(d.suggestion).toMatch(/no matching/);
  });

  it('an unclosed field reference and an unclosed string are positioned at their opening', () => {
    expect(diagnose('{Qty + 1').position.start).toBe(0);
    const s = diagnose('"abc');
    expect(s.position.start).toBe(0);
    expect(s.message).toMatch(/Unclosed string/);
  });

  it('every diagnostic has every key, null when not applicable', () => {
    const d = diagnose('{Qty} +');
    expect(Object.keys(d).sort()).toEqual(['expected', 'got', 'message', 'position', 'suggestion']);
    expect(d.position.end).toBeGreaterThanOrEqual(d.position.start);
  });

  it('nearestName keeps the threshold honest and is case-insensitive', () => {
    expect(nearestName('QTY', ['Qty', 'Name'])).toBe('Qty');
    expect(nearestName('zzzzzz', ['Qty', 'Name', 'Unit Price'])).toBeUndefined();
    expect(nearestName('x', [])).toBeUndefined();
  });

  it('MUST KEEP: formulas that were valid still parse and typecheck to the same type', () => {
    for (const [src, type] of [
      ['{Qty} * {Unit Price}', 'number'],
      ['if({Urgent}, "yes", "no")', 'text'],
      ['round({Qty} / 3, 2)', 'number'],
      ['({Qty} + 1) * 2', 'number'],
    ] as const) {
      expect(typecheck(parseFormula(src, FIELDS), FIELDS)).toBe(type);
    }
  });
});
