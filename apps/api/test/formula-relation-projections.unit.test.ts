import { describe, expect, it } from 'vitest';
import { evaluateFormula, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo, RelatedBags } from '@storyos/schemas';

/**
 * #594 — pluck() projects one field across (optionally filtered) related
 * records into a list, reusing the same filter-evaluation path
 * count()/sum()/avg()/min()/max() already use (see #298's own file,
 * formula-relation-aggregates.unit.test.ts, for that shared machinery's own
 * tests) — this file only covers what's NEW: the projection itself.
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

describe('#594 pluck() over a relation', () => {
  it('projects a text field across every linked record', () => {
    expect(run('pluck({Issues.Title})')).toEqual(['a', 'b', 'c']);
  });

  it('projects a NUMBER field too — no type restriction, unlike sum/avg/min/max', () => {
    expect(run('pluck({Issues.Estimate})')).toEqual(['3', '5', '2']);
  });

  it('projects only records matching a condition', () => {
    expect(run('pluck({Issues.Title}, {Issues.State} = "Done")')).toEqual(['a', 'c']);
  });

  it('is an EMPTY list — not null — for an empty relation, matching split()\'s empty-string behaviour', () => {
    expect(run('pluck({Issues.Title})', { issues: [] })).toEqual([]);
  });

  it('drops a related record with no value for the field rather than stringifying null', () => {
    const bags: RelatedBags = { issues: [{ title: 'a' }, { title: null }, { title: 'c' }] };
    expect(run('pluck({Issues.Title})', bags)).toEqual(['a', 'c']);
  });

  it('composes with join() and size(), the same as split()\'s list', () => {
    expect(run('join(pluck({Issues.Title}), ", ")')).toBe('a, b, c');
    expect(run('size(pluck({Issues.Title}))')).toBe(3);
    expect(run('at(pluck({Issues.Title}), 2)')).toBe('b');
  });

  it('cannot RETURN a list at the top level — the exact restriction split() already has (#241)', () => {
    expect(() => type('pluck({Issues.Title})')).toThrow(/must end in a value, not a list/);
    // Composed with join()/at(), it typechecks fine — same as split().
    expect(type('join(pluck({Issues.Title}), ", ")')).toBe('text');
    expect(type('at(pluck({Issues.Title}), 1)')).toBe('text');
    expect(type('size(pluck({Issues.Title}))')).toBe('number');
  });

  it('refuses a bare relation with no field — count()\'s error shape, adapted', () => {
    expect(() => type('pluck({Issues})')).toThrow(/needs a field to project/);
  });

  it('refuses more than a field + condition', () => {
    expect(() => type('pluck({Issues.Title}, {Issues.State} = "Done", 1)')).toThrow(
      /takes the link.field and an optional condition/,
    );
  });

  it('refuses a non-boolean condition', () => {
    expect(() => type('pluck({Issues.Title}, {Issues.Estimate})')).toThrow(/condition must be true\/false/);
  });

  it('MUST KEEP WORKING: split()/join()/at()/size() and every RELATION_AGGREGATES function are unchanged', () => {
    expect(run('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
    expect(run('count({Issues})')).toBe(3);
    expect(run('sum({Issues.Estimate})')).toBe(10);
    expect(run('avg({Issues.Estimate})')).toBe(10 / 3);
    expect(run('min({Issues.Estimate})')).toBe(2);
    expect(run('max({Issues.Estimate})')).toBe(5);
  });
});
