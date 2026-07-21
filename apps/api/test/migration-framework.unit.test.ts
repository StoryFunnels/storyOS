import { describe, expect, it } from 'vitest';
import { coerceScalar, inferFieldType } from '../src/migration-framework/field-type-mapping';
import { buildTitleIndex, resolveTargetsByTitle, splitTargets } from '../src/migration-framework/relation-resolver';
import { buildLabelIndex, pickOption } from '../src/migration-framework/select-options';
import { DryRunBuilder } from '../src/migration-framework/dry-run';
import { chunk } from '../src/migration-framework/chunked-apply.service';

// The shared migration framework (#198 / MN-236, ADR-0013). These are pure-logic
// unit tests — no DB, no Nest app — for the primitives every importer (CSV,
// Linear, and the four planned competitor importers) now shares.

describe('inferFieldType (generalized from MN-052)', () => {
  it('recognizes booleans, numbers, dates, emails, urls', () => {
    expect(inferFieldType(['true', 'false', 'yes', 'no'])).toEqual({ type: 'checkbox' });
    expect(inferFieldType(['12000', '4500', '3.5'])).toEqual({ type: 'number' });
    expect(inferFieldType(['2026-01-01', '15.02.2026'])).toEqual({ type: 'date' });
    expect(inferFieldType(['a@b.com', 'c@d.com'])).toEqual({ type: 'email' });
    expect(inferFieldType(['https://a.com', 'https://b.com'])).toEqual({ type: 'url' });
  });

  it('infers select only when values repeat within the 24-distinct cap', () => {
    expect(inferFieldType(['Discovery', 'Delivery', 'Discovery', 'Delivery'])).toEqual({
      type: 'select',
      options: ['Discovery', 'Delivery'],
    });
    // 3 distinct values seen once each — no repeats, so text, not select.
    expect(inferFieldType(['a', 'b', 'c'])).toEqual({ type: 'text' });
  });

  it('falls back to text for an empty sample or free-form values', () => {
    expect(inferFieldType([])).toEqual({ type: 'text' });
    expect(inferFieldType(['some free text', 'more free text'])).toEqual({ type: 'text' });
  });
});

describe('coerceScalar (generalized from MN-052)', () => {
  it('parses numbers with thousands separators and commas as decimal points', () => {
    expect(coerceScalar('number', '4 500')).toBe(4500);
    expect(coerceScalar('number', '12,5')).toBe(12.5);
    expect(coerceScalar('number', 'not-a-number')).toBeUndefined();
  });

  it('parses checkboxes and both date formats', () => {
    expect(coerceScalar('checkbox', 'yes')).toBe(true);
    expect(coerceScalar('checkbox', 'no')).toBe(false);
    expect(coerceScalar('date', '15.02.2026')).toBe('2026-02-15');
    expect(coerceScalar('date', '2026-03-01')).toBe('2026-03-01');
  });

  it('drops blank cells instead of coercing them to an empty string', () => {
    expect(coerceScalar('text', '')).toBeUndefined();
    expect(coerceScalar('text', '  ')).toBeUndefined();
  });
});

describe('relation resolution by title (generalized from MN-052/MN-075)', () => {
  const index = buildTitleIndex([
    { id: '1', title: 'Globex' },
    { id: '2', title: 'Initech' },
    { id: '3', title: 'Dup' },
    { id: '4', title: 'Dup' },
  ]);

  it('matches case-insensitively and marks shared titles ambiguous', () => {
    expect(index.get('globex')).toBe('1');
    expect(index.get('dup')).toBeNull(); // ambiguous — never guess
    expect(index.get('missing')).toBeUndefined();
  });

  it('splits a comma-separated relation cell (MN-075 many-to-many export shape)', () => {
    expect(splitTargets('Globex, Initech')).toEqual(['Globex', 'Initech']);
    expect(splitTargets('  Globex ,   Initech  ')).toEqual(['Globex', 'Initech']);
  });

  it('resolves hits and collects one warning per miss/ambiguous target — never fails the row', () => {
    const { hits, warnings } = resolveTargetsByTitle(index, 'Globex, Nowhere Co, Dup');
    expect(hits).toEqual(['1']);
    expect(warnings).toEqual(['no record titled "Nowhere Co"', '"Dup" is ambiguous']);
  });
});

describe('select option matching (shared by CSV and Linear, #68)', () => {
  const options = buildLabelIndex([
    { id: 'o1', label: 'Backlog' },
    { id: 'o2', label: 'Done' },
  ]);

  it('matches case-insensitively and tries candidates in order', () => {
    expect(pickOption(options, 'backlog')).toBe('o1');
    expect(pickOption(options, undefined, 'DONE')).toBe('o2');
  });

  it('returns null when nothing matches', () => {
    expect(pickOption(options, 'nope')).toBeNull();
    expect(pickOption(options, undefined)).toBeNull();
  });
});

describe('DryRunBuilder (unified dry-run contract, ADR-0013 §4)', () => {
  it('caps warnings at 100 and sample rows at 5, while still counting the true totals', () => {
    const report = new DryRunBuilder();
    for (let i = 0; i < 150; i++) report.addWarning({ row: i, column: 'x', message: 'bad cell' });
    for (let i = 0; i < 10; i++) report.addSample({ i });
    report.willCreate = 150;
    report.willUpdate = 3;
    report.newFields = [{ display_name: 'Status', type: 'select' }];

    const built = report.build();
    expect(built.warnings).toHaveLength(100);
    expect(built.warnings_total).toBe(150);
    expect(built.sample).toHaveLength(5);
    expect(built.will_create).toBe(150);
    expect(built.will_update).toBe(3);
    expect(built.new_fields).toEqual([{ display_name: 'Status', type: 'select' }]);
  });

  it('starts at zero with no warnings/sample when nothing was added', () => {
    const built = new DryRunBuilder().build();
    expect(built).toEqual({
      will_create: 0,
      will_update: 0,
      new_fields: [],
      warnings: [],
      warnings_total: 0,
      sample: [],
    });
  });
});

describe('chunk (shared chunked-apply sizing, ADR-0013 §3)', () => {
  it('splits into fixed-size groups with a final remainder chunk', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for an empty input', () => {
    expect(chunk([], 500)).toEqual([]);
  });

  it('returns a single chunk when everything fits', () => {
    expect(chunk([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });
});
