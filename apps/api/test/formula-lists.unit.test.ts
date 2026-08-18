import { describe, expect, it } from 'vitest';
import { evaluateFormula, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';

/**
 * #241 — split() into a list, join() back, at() and size().
 *
 * `list` is deliberately an INTERMEDIATE type: a formula may use one but not
 * return one. Storing a list would force answers this feature doesn't need —
 * how it sorts, what a filter on it means, how a cell renders it — and the
 * request ("split a Full Name into First and Last") never needed them.
 */
const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'full_name', display_name: 'Full Name', formula_type: 'text' },
  { api_name: 'tags', display_name: 'Tags', formula_type: 'text' },
  { api_name: 'count', display_name: 'Count', formula_type: 'number' },
];
const VALUES = { full_name: 'Ferrari, Enzo', tags: 'a,b,c' };

const run = (src: string) => evaluateFormula(parseFormula(src, FIELDS), VALUES);
const type = (src: string) => typecheck(parseFormula(src, FIELDS), FIELDS);

describe('split / join / at / size (#241)', () => {
  it('splits a "Last, First" value into its parts — the reported use case', () => {
    expect(run('at(split({Full Name}, ", "), 1)')).toBe('Ferrari');
    expect(run('at(split({Full Name}, ", "), 2)')).toBe('Enzo');
  });

  it('join is the inverse of split for the same separator', () => {
    expect(run('join(split({Tags}, ","), ",")')).toBe('a,b,c');
  });

  it('size counts the parts', () => {
    expect(run('size(split({Tags}, ","))')).toBe(3);
  });

  it('a separator that does not occur gives a single-element list', () => {
    expect(run('size(split({Tags}, "|"))')).toBe(1);
    expect(run('join(split({Tags}, "|"), "-")')).toBe('a,b,c');
  });

  it('empty input is an EMPTY list, not one blank part', () => {
    // "no parts" and "one empty part" are different answers; size() has to be
    // able to say 0.
    expect(evaluateFormula(parseFormula('size(split({Full Name}, ","))', FIELDS), { full_name: '' })).toBe(0);
  });

  it('at() out of range is empty, never an error', () => {
    expect(run('at(split({Tags}, ","), 99)')).toBe('');
    expect(run('at(split({Tags}, ","), 0)')).toBe('');
  });

  it('the original 3-argument split still returns the Nth part as text', () => {
    // Formulas in the wild use this; the 2-arg list form is additive.
    expect(run('split({Tags}, ",", 2)')).toBe('b');
    expect(type('split({Tags}, ",", 2)')).toBe('text');
  });

  it('composes: split, read a part, and use it as text', () => {
    expect(run('upper(at(split({Full Name}, ", "), 2))')).toBe('ENZO');
  });
});

describe('lists are intermediate-only, and say so (#241)', () => {
  it('refuses a formula that RETURNS a list, naming the fix', () => {
    expect(() => type('split({Tags}, ",")')).toThrow(/must end in a value, not a list/);
    expect(() => type('split({Tags}, ",")')).toThrow(/join|at/);
  });

  it('refuses a list handed to an ordinary function', () => {
    expect(() => type('upper(split({Tags}, ","))')).toThrow(/cannot take a list/);
  });

  it('refuses join/at/size on something that is not a list', () => {
    expect(() => type('join({Tags}, ",")')).toThrow(/needs a list/);
    expect(() => type('at({Tags}, 1)')).toThrow(/needs a list/);
    expect(() => type('size({Tags})')).toThrow(/needs a list/);
  });

  it("refuses at() with a non-number position", () => {
    expect(() => type('at(split({Tags}, ","), "1")')).toThrow(/must be a number/);
  });

  it('typechecks the good forms', () => {
    expect(type('join(split({Tags}, ","), " · ")')).toBe('text');
    expect(type('at(split({Tags}, ","), 1)')).toBe('text');
    expect(type('size(split({Tags}, ","))')).toBe('number');
  });
});
