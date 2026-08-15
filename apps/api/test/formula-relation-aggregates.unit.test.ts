import { describe, expect, it } from 'vitest';
import { evaluateFormula, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo, RelatedBags } from '@storyos/schemas';

/**
 * #298 — count/sum/avg/min/max across a relation, with an optional condition.
 *
 * The dotted form is what makes the scope resolvable: `{Estimate}` alone would
 * be looked up against the OWN database's names, and Estimate lives on the
 * related one.
 */
const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'name', display_name: 'Name', formula_type: 'text' },
  { api_name: 'budget', display_name: 'Budget', formula_type: 'number' },
  {
    api_name: 'issues',
    display_name: 'Issues',
    formula_type: 'relation',
    related: [
      { api_name: 'estimate', display_name: 'Estimate', formula_type: 'number' },
      { api_name: 'state', display_name: 'State', formula_type: 'text' },
      { api_name: 'title', display_name: 'Title', formula_type: 'text' },
    ],
  },
];

const BAGS: RelatedBags = {
  issues: [
    { estimate: 3, state: 'Done', title: 'a' },
    { estimate: 5, state: 'Open', title: 'b' },
    { estimate: 2, state: 'Done', title: 'c' },
  ],
};

const run = (src: string, bags: RelatedBags = BAGS, own: Record<string, unknown> = {}) =>
  evaluateFormula(parseFormula(src, FIELDS), own, bags);

const type = (src: string) => typecheck(parseFormula(src, FIELDS), FIELDS);

describe('count over a relation (#298)', () => {
  it('counts the linked records', () => {
    expect(run('count({Issues})')).toBe(3);
  });

  it('counts only those matching a condition', () => {
    expect(run('count({Issues}, {Issues.State} = "Done")')).toBe(2);
  });

  it('is 0 — not null — for an empty relation, matching rollup', () => {
    expect(run('count({Issues})', { issues: [] })).toBe(0);
  });

  it('is 0 when no related records match the condition', () => {
    expect(run('count({Issues}, {Issues.State} = "Nope")')).toBe(0);
  });

  it('rejects a field path, since it counts records not values', () => {
    expect(() => type('count({Issues.Estimate})')).toThrow(/count\(\) counts linked records/);
  });
});

describe('sum / avg / min / max over a relation (#298)', () => {
  it('aggregates the related number field', () => {
    expect(run('sum({Issues.Estimate})')).toBe(10);
    expect(run('avg({Issues.Estimate})')).toBeCloseTo(10 / 3);
    expect(run('min({Issues.Estimate})')).toBe(2);
    expect(run('max({Issues.Estimate})')).toBe(5);
  });

  it('applies the condition per related record', () => {
    expect(run('sum({Issues.Estimate}, {Issues.State} = "Done")')).toBe(5);
    expect(run('max({Issues.Estimate}, {Issues.State} = "Done")')).toBe(3);
  });

  /**
   * null, not 0. "No data" and "adds up to zero" are different answers, and
   * rollup already answers null here — the two paths must never disagree on the
   * same data, or a user with both sees the product contradict itself.
   */
  it('is null for an empty relation', () => {
    for (const fn of ['sum', 'avg', 'min', 'max']) {
      expect(run(`${fn}({Issues.Estimate})`, { issues: [] })).toBeNull();
    }
  });

  it('is null when the condition matches nothing', () => {
    expect(run('sum({Issues.Estimate}, {Issues.State} = "Nope")')).toBeNull();
  });

  it('ignores related records with no value for the field', () => {
    const bags: RelatedBags = { issues: [{ estimate: 4 }, { estimate: null }, {}] };
    expect(run('sum({Issues.Estimate})', bags)).toBe(4);
    expect(run('avg({Issues.Estimate})', bags)).toBe(4);
  });

  it('needs a field to aggregate', () => {
    expect(() => type('sum({Issues})')).toThrow(/needs a field to aggregate/);
  });

  it('refuses to aggregate a non-number field', () => {
    expect(() => type('sum({Issues.State})')).toThrow(/needs a number field/);
  });
});

describe('sum keeps its own-record behaviour (#288 must not regress)', () => {
  it('still adds its arguments when given plain numbers', () => {
    expect(evaluateFormula(parseFormula('sum({Budget}, 5)', FIELDS), { budget: 10 })).toBe(15);
  });

  it('dispatches on the argument, so one name means one thing', () => {
    expect(type('sum({Budget}, 5)')).toBe('number');
    expect(type('sum({Issues.Estimate})')).toBe('number');
  });
});

describe('a bare relation is not a value (#298)', () => {
  it('cannot be used in arithmetic', () => {
    expect(() => type('{Issues} + 1')).toThrow(/set of records/);
  });

  it('cannot be compared', () => {
    expect(() => type('{Issues} > 2')).toThrow(/set of records/);
  });

  it('cannot be passed to an ordinary function', () => {
    expect(() => type('upper({Issues})')).toThrow(/cannot take a link field/);
  });
});

describe('resolution errors name the problem (#298)', () => {
  it('rejects a dot on a non-relation field', () => {
    expect(() => parseFormula('{Budget.Something}', FIELDS)).toThrow(/not a link to another database/);
  });

  it('rejects an unknown field on the related database', () => {
    expect(() => parseFormula('{Issues.Nonsense}', FIELDS)).toThrow(/not a field on the records/);
  });

  it('rejects an unknown relation', () => {
    expect(() => parseFormula('{Nope.Estimate}', FIELDS)).toThrow(/Unknown field/);
  });

  it('resolves by api_name as well as display name', () => {
    expect(run('sum({issues.estimate})')).toBe(10);
  });
});

describe('an aggregate composes with the rest of the language (#298)', () => {
  it('works inside arithmetic', () => {
    expect(run('sum({Issues.Estimate}) * 2')).toBe(20);
  });

  it('works inside if()', () => {
    expect(run('if(count({Issues}) > 2, "busy", "calm")')).toBe('busy');
  });

  it('reads as an empty relation when the caller supplies no bags', () => {
    // The web editor's live preview has no related data — it must degrade to
    // "nothing linked", never throw.
    expect(evaluateFormula(parseFormula('count({Issues})', FIELDS), {})).toBe(0);
    expect(evaluateFormula(parseFormula('sum({Issues.Estimate})', FIELDS), {})).toBeNull();
  });
});
