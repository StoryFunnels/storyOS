import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isApplied, isUnfinished } from '../views/filter-state';
import { defaultValueFor, opsForField } from '../views/view-toolbar';
import type { Field } from '../table-view/use-table-data';

/**
 * #1161 — a record page's collection filter used to store `value: undefined` for a new condition while its chip
 * read "within next 7 days": it looked applied and narrowed nothing. The rules, as pure functions.
 */
const c = (extra: Record<string, unknown>) => ({ field: 'due', op: 'within', ...extra }) as never;

describe('isApplied / isUnfinished (#1161)', () => {
  it('a condition with a value is applied and not unfinished', () => {
    expect(isApplied(c({ value: 'next_7_days' }))).toBe(true);
    expect(isUnfinished(c({ value: 'next_7_days' }))).toBe(false);
  });

  it('no value, an empty string or an empty list is unfinished and NOT applied', () => {
    for (const value of [undefined, null, '', []]) {
      expect(isApplied(c({ value }))).toBe(false);
      expect(isUnfinished(c({ value }))).toBe(true);
    }
  });

  it('is_empty / not_empty carry no value by design: applied, never unfinished', () => {
    expect(isApplied(c({ op: 'is_empty' }))).toBe(true);
    expect(isUnfinished(c({ op: 'not_empty' }))).toBe(false);
  });

  it('zero and false are values (what a filter must KEEP)', () => {
    expect(isApplied(c({ op: 'eq', value: 0 }))).toBe(true);
    expect(isApplied(c({ op: 'eq', value: false }))).toBe(true);
  });

  it('a disabled condition is neither applied nor unfinished: it is a choice, not a gap', () => {
    expect(isApplied(c({ value: 'x', disabled: true }))).toBe(false);
    expect(isUnfinished(c({ disabled: true }))).toBe(false);
  });
});

describe('adding a date condition (#1161)', () => {
  const dateField = { id: 'f', apiName: 'due', displayName: 'Due', type: 'date' } as unknown as Field;

  it('the first date operator is the relative range, and the value that is shown is the value that is saved', () => {
    const first = opsForField(dateField)[0]!;
    expect(first.input).toBe('relative');
    expect(defaultValueFor(first.input)).toBe('next_7_days');
    expect(isApplied({ field: 'due', op: first.op, value: defaultValueFor(first.input) } as never)).toBe(true);
  });

  it('an exact-date operator starts empty: unfinished, so it must look and act unfinished', () => {
    const before = opsForField(dateField).find((o) => o.op === 'before')!;
    expect(isUnfinished({ field: 'due', op: before.op, value: defaultValueFor(before.input) } as never)).toBe(true);
  });
});

describe('the collection mount uses the shared helpers (#1161 source guard)', () => {
  const section = readFileSync(join(__dirname, 'collection-section.tsx'), 'utf8');
  const toolbar = readFileSync(join(__dirname, '../views/view-toolbar.tsx'), 'utf8');

  it('queries only isApplied conditions and keeps no private copy of the rule', () => {
    expect(section).toContain('.filter(isApplied)');
    expect(section).not.toMatch(/valueless\s*=/);
  });

  it('a new condition takes defaultValueFor, never a bare undefined', () => {
    expect(section).toContain('value: defaultValueFor(op.input)');
    expect(section).not.toMatch(/value:\s*undefined/);
  });

  it('the chip marks an unfinished condition with the shared dashed treatment and words', () => {
    expect(toolbar).toMatch(/const unfinished = isUnfinished\(condition\);/);
    expect(toolbar).toContain('not applied yet');
  });
});
