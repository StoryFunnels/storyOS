import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS,
  FORMULA_OPERATORS,
  FormulaError,
  evaluateFormula,
  parseFormula,
  typecheck,
  type FormulaFieldInfo,
} from '@storyos/schemas';

/**
 * #288 — the formula library gap-fill. Tests live here (not in packages/schemas,
 * which has no test runner) next to the other pure-unit field tests.
 *
 * Each new function is exercised through the WHOLE pipeline — parse → typecheck
 * → evaluate — rather than by calling `.impl` directly, because half the ways
 * these can be wrong live in the typechecker (`switch`'s result type, arity on a
 * `variadic-any` spec) rather than in the implementation.
 */

/**
 * Every field name any doc example references, so the "examples all parse" test
 * below can check the WHOLE table rather than a hand-picked subset.
 */
const FIELD_TYPES: Record<string, 'text' | 'number' | 'date' | 'checkbox'> = {
  Name: 'text', Nickname: 'text', State: 'text', Status: 'text', Code: 'text',
  Notes: 'text', Email: 'text', File: 'text', Phone: 'text', Raw: 'text',
  Slug: 'text', Imported: 'text',
  Estimate: 'number', A: 'number', B: 'number', Area: 'number', Base: 'number',
  Budget: 'number', Count: 'number', Delta: 'number', Fees: 'number',
  Hours: 'number', Paid: 'number', Rate: 'number', Tax: 'number', Total: 'number',
  Due: 'date', Start: 'date', Started: 'date', Invoiced: 'date', Opened: 'date',
  Done: 'checkbox', Approved: 'checkbox', Overdue: 'checkbox', Urgent: 'checkbox',
};

const FIELDS: FormulaFieldInfo[] = Object.entries(FIELD_TYPES).map(([display, type]) => ({
  api_name: display.toLowerCase(),
  display_name: display,
  formula_type: type,
}));

function run(src: string, values: Record<string, unknown> = {}): unknown {
  const ast = parseFormula(src, FIELDS);
  typecheck(ast, FIELDS);
  return evaluateFormula(ast, values);
}

function typeOf(src: string): string {
  const ast = parseFormula(src, FIELDS);
  return typecheck(ast, FIELDS);
}

describe('switch()', () => {
  it('returns the matching result', () => {
    expect(run('switch({State}, "Done", 100, "Doing", 50, 0)', { state: 'Doing' })).toBe(50);
  });

  it('falls back to the trailing default', () => {
    expect(run('switch({State}, "Done", 100, "Doing", 50, 0)', { state: 'Todo' })).toBe(0);
  });

  it('is null with no default and no match', () => {
    expect(run('switch({State}, "Done", 100)', { state: 'Todo' })).toBeNull();
  });

  it('types as its RESULTS, not as the compared value', () => {
    // The bug this guards: `same-as-arg2` would have reported `text` here (the
    // type of {State}), so `switch(...) + 1` would fail to typecheck.
    expect(typeOf('switch({State}, "Done", 100, 0)')).toBe('number');
    expect(typeOf('switch({State}, "Done", 100, 0) + 1')).toBe('number');
  });

  it('rejects too few arguments instead of silently returning null', () => {
    expect(() => run('switch({State})')).toThrow(FormulaError);
  });
});

describe('text functions', () => {
  it.each([
    ['contains({Name}, "urg")', { name: 'urgent' }, true],
    ['contains({Name}, "zz")', { name: 'urgent' }, false],
    ['starts_with({Name}, "INV-")', { name: 'INV-9' }, true],
    ['ends_with({Name}, ".pdf")', { name: 'a.pdf' }, true],
    ['left({Name}, 3)', { name: 'abcdef' }, 'abc'],
    ['right({Name}, 3)', { name: 'abcdef' }, 'def'],
    ['substring({Name}, 2, 3)', { name: 'abcdef' }, 'bcd'],
    ['find({Name}, "@")', { name: 'a@b.com' }, 2],
    ['find({Name}, "@")', { name: 'nope' }, 0],
    ['split({Name}, "@", 2)', { name: 'a@b.com' }, 'b.com'],
    ['split({Name}, "@", 5)', { name: 'a@b.com' }, ''],
  ])('%s', (src, values, expected) => {
    expect(run(src, values)).toBe(expected);
  });

  it('right() with 0 returns empty, not the whole string', () => {
    // slice(-0) is slice(0) — the whole string. Easy to get wrong.
    expect(run('right({Name}, 0)', { name: 'abcdef' })).toBe('');
  });

  it('substring() start is 1-based like a spreadsheet', () => {
    expect(run('substring({Name}, 1, 2)', { name: 'abcdef' })).toBe('ab');
  });

  it('treats an empty field as empty text rather than throwing', () => {
    expect(run('contains({Name}, "x")', {})).toBe(false);
    expect(run('left({Name}, 2)', { name: null })).toBe('');
  });
});

describe('math functions', () => {
  it.each([
    ['ceil({Estimate})', { estimate: 1.2 }, 2],
    ['floor({Estimate})', { estimate: 1.8 }, 1],
    ['mod({Estimate}, 2)', { estimate: 7 }, 1],
    ['sqrt({Estimate})', { estimate: 9 }, 3],
    ['pow({Estimate}, 2)', { estimate: 3 }, 9],
    ['sum({Estimate}, 5)', { estimate: 2 }, 7],
  ])('%s', (src, values, expected) => {
    expect(run(src, values)).toBe(expected);
  });

  it('never divides by zero or returns Infinity/NaN', () => {
    expect(run('mod({Estimate}, 0)', { estimate: 7 })).toBeNull();
    expect(run('sqrt({Estimate})', { estimate: -1 })).toBeNull();
    expect(run('pow(10, {Estimate})', { estimate: 100000 })).toBeNull();
  });

  it('is null when the input is empty', () => {
    expect(run('ceil({Estimate})', {})).toBeNull();
  });
});

describe('date functions', () => {
  const at = { due: '2026-03-15T13:45:00.000Z', start: '2026-01-31' };

  it.each([
    ['day({Due})', 15],
    ['weekday({Due})', 7], // 2026-03-15 is a Sunday
    ['hour({Due})', 13],
    ['minute({Due})', 45],
  ])('%s', (src, expected) => {
    expect(run(src, at)).toBe(expected);
  });

  it('date_diff counts whole units', () => {
    // 43d13h45m rounds to 44, matching the existing days_between() — the two
    // disagreeing on the same pair of dates would be worse than either rule.
    expect(run('date_diff({Start}, {Due}, "days")', at)).toBe(44);
    expect(run('date_diff({Start}, {Due}, "weeks")', at)).toBe(6);
    expect(run('date_diff({Start}, {Due}, "months")', at)).toBe(1);
    expect(run('date_diff({Start}, {Due}, "years")', at)).toBe(0);
  });

  it('date_diff months is calendar-aware, not 30-day arithmetic', () => {
    // Jan 31 → Feb 28 is 0 whole months, which is what people mean.
    expect(run('date_diff({Start}, {Due}, "months")', { start: '2026-01-31', due: '2026-02-28' })).toBe(0);
    expect(run('date_diff({Start}, {Due}, "months")', { start: '2026-01-31', due: '2026-03-01' })).toBe(1);
  });

  it('date_diff rejects an unknown unit with null rather than guessing', () => {
    expect(run('date_diff({Start}, {Due}, "fortnights")', at)).toBeNull();
  });

  it('add_months clamps into a shorter month', () => {
    expect(run('add_months({Start}, 1)', { start: '2026-01-31' })).toBe('2026-02-28');
    expect(run('add_months({Start}, 12)', { start: '2026-01-31' })).toBe('2027-01-31');
    expect(run('add_months({Start}, -1)', { start: '2026-03-31' })).toBe('2026-02-28');
  });

  it('end_of_month handles February and leap years', () => {
    expect(run('end_of_month({Start})', { start: '2026-02-10' })).toBe('2026-02-28');
    expect(run('end_of_month({Start})', { start: '2028-02-10' })).toBe('2028-02-29');
  });

  it('is_before / is_after', () => {
    expect(run('is_before({Start}, {Due})', at)).toBe(true);
    expect(run('is_after({Start}, {Due})', at)).toBe(false);
  });

  it('workdays_between skips weekends and signs backwards ranges', () => {
    // Mon 2026-03-02 → Mon 2026-03-09 is 5 weekdays.
    expect(run('workdays_between({Start}, {Due})', { start: '2026-03-02', due: '2026-03-09' })).toBe(5);
    expect(run('workdays_between({Start}, {Due})', { start: '2026-03-09', due: '2026-03-02' })).toBe(-5);
    expect(run('workdays_between({Start}, {Due})', { start: '2026-03-02', due: '2026-03-02' })).toBe(0);
  });

  it('date helpers are null on an empty date', () => {
    expect(run('day({Due})', {})).toBeNull();
    expect(run('add_months({Start}, 1)', {})).toBeNull();
    expect(run('workdays_between({Start}, {Due})', { start: null, due: '2026-03-09' })).toBeNull();
  });
});

describe('casts', () => {
  it('to_number parses, including thousands separators', () => {
    expect(run('to_number({Name})', { name: ' 42 ' })).toBe(42);
    expect(run('to_number({Name})', { name: '1,200' })).toBe(1200);
  });

  it('to_number is null — not 0 — for empty or non-numeric text', () => {
    // Number('') is 0; returning 0 would fabricate data in a rollup.
    expect(run('to_number({Name})', { name: '' })).toBeNull();
    expect(run('to_number({Name})', { name: 'abc' })).toBeNull();
  });

  it('to_date parses or gives null', () => {
    expect(run('to_date({Name})', { name: '2026-03-15' })).toBe('2026-03-15T00:00:00.000Z');
    expect(run('to_date({Name})', { name: 'not a date' })).toBeNull();
  });

  it('nullif blanks a sentinel value', () => {
    expect(run('nullif({State}, "Unknown")', { state: 'Unknown' })).toBeNull();
    expect(run('nullif({State}, "Unknown")', { state: 'Done' })).toBe('Done');
    expect(() => run('nullif({State})')).toThrow(FormulaError);
  });
});

describe('discoverability', () => {
  it('lists the infix logic operators the function table cannot hold', () => {
    // The actual #288 complaint: `and`/`or`/`not` are parsed as OPERATORS, so a
    // user scanning the function list concluded logic was unsupported.
    const ops = FORMULA_OPERATORS.map((o) => o.op);
    expect(ops).toContain('and');
    expect(ops).toContain('or');
    expect(ops).toContain('not');
    expect(run('{Done} and not {Done}', { done: true })).toBe(false);
  });

  it('does not duplicate an operator as a function', () => {
    for (const op of ['and', 'or', 'not']) {
      expect(FORMULA_FUNCTIONS[op]).toBeUndefined();
    }
  });

  it('every function has a doc and a parseable example', () => {
    for (const [name, spec] of Object.entries(FORMULA_FUNCTIONS)) {
      expect(spec.doc, `${name} doc`).toBeTruthy();
      expect(spec.example, `${name} example`).toBeTruthy();
      // The editor's help panel offers examples as insertable snippets, so a
      // typo in one ships a formula the user cannot save.
      expect(() => typecheck(parseFormula(spec.example, FIELDS), FIELDS), `${name} example`).not.toThrow();
    }
  });
});
