import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS,
  parseFormula,
  relationAggregateExamples,
  typecheck,
  usesRelationAggregate,
} from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';

/**
 * #299 — the discoverability layer over #298's engine.
 *
 * #287's finding was that the capability existed and nobody could find it, so
 * these assert the things a user actually does: search for a word they know,
 * and click the example they are shown. The load-bearing one is
 * "every generated example parses and typechecks" — an example that errors when
 * clicked is worse than no example at all.
 */
const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'name', display_name: 'Name', formula_type: 'text' },
  {
    api_name: 'issues',
    display_name: 'Issues',
    formula_type: 'relation',
    related: [
      { api_name: 'estimate', display_name: 'Estimate', formula_type: 'number' },
      { api_name: 'state', display_name: 'State', formula_type: 'text' },
    ],
  },
];

describe('relationAggregateExamples (#299)', () => {
  it('names the user’s OWN link and field, not a placeholder', () => {
    const examples = relationAggregateExamples(FIELDS);
    expect(examples.map((e) => e.example)).toContain('count({Issues})');
    expect(examples.map((e) => e.example)).toContain('sum({Issues.Estimate})');
    // The whole point of the ticket: nothing generic survives into the help.
    expect(examples.every((e) => e.example.includes('{Issues'))).toBe(true);
  });

  it('every generated example parses and typechecks', () => {
    for (const e of relationAggregateExamples(FIELDS)) {
      expect(() => typecheck(parseFormula(e.example, FIELDS), FIELDS), e.example).not.toThrow();
    }
  });

  it('offers count but NOT sum when the linked database has no number field', () => {
    const noNumbers: FormulaFieldInfo[] = [
      {
        api_name: 'tags',
        display_name: 'Tags',
        formula_type: 'relation',
        related: [{ api_name: 'label', display_name: 'Label', formula_type: 'text' }],
      },
    ];
    const names = relationAggregateExamples(noNumbers).map((e) => e.name);
    expect(names).toEqual(['count']);
    // Because sum({Tags.Label}) is exactly what the typechecker rejects — an
    // example that errors on click is how users conclude a feature is broken.
    expect(() => typecheck(parseFormula('sum({Tags.Label})', noNumbers), noNumbers)).toThrow(
      /needs a number field/,
    );
  });

  it('returns nothing when the database has no links at all', () => {
    expect(relationAggregateExamples([{ api_name: 'a', display_name: 'A', formula_type: 'number' }])).toEqual([]);
  });
});

describe('search keywords (#299)', () => {
  const matches = (q: string) =>
    Object.entries(FORMULA_FUNCTIONS)
      .filter(
        ([name, spec]) =>
          name.includes(q) ||
          spec.doc.toLowerCase().includes(q) ||
          (spec.keywords ?? []).some((k) => k.includes(q) || q.includes(k)),
      )
      .map(([name]) => name);

  it('finds count from the words people type instead of "count"', () => {
    expect(matches('how many')).toContain('count');
    expect(matches('number of')).toContain('count');
  });

  it('finds sum from "total"', () => {
    expect(matches('total')).toContain('sum');
  });

  it('finds avg from "average" — the name itself never matches it', () => {
    expect('avg'.includes('average')).toBe(false);
    expect(matches('average')).toContain('avg');
  });
});

describe('usesRelationAggregate (#299)', () => {
  it('is true for an aggregate, at the top level or nested', () => {
    expect(usesRelationAggregate(parseFormula('count({Issues})', FIELDS))).toBe(true);
    expect(usesRelationAggregate(parseFormula('sum({Issues.Estimate}) * 2', FIELDS))).toBe(true);
    expect(usesRelationAggregate(parseFormula('if(count({Issues}) > 2, "a", "b")', FIELDS))).toBe(true);
  });

  it('is false for the same function names over own-record values', () => {
    const own: FormulaFieldInfo[] = [{ api_name: 'a', display_name: 'A', formula_type: 'number' }];
    expect(usesRelationAggregate(parseFormula('sum({A}, 2)', own))).toBe(false);
    expect(usesRelationAggregate(parseFormula('max({A}, 2)', own))).toBe(false);
  });

  it('is not fooled by the word appearing in a string literal', () => {
    // A regex over the source would fire here; walking the AST does not.
    expect(usesRelationAggregate(parseFormula('"count({Issues})"', FIELDS))).toBe(false);
  });
});
