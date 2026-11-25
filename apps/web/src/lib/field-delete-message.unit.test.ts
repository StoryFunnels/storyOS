import { describe, expect, it } from 'vitest';
import { fieldDeleteMessage, parseFieldUsage, type FieldUsage } from './field-delete-message';

const u = (count: number, storage: string, complete = true): FieldUsage => ({ count, storage, complete });
const field = (usage: FieldUsage | null) => fieldDeleteMessage({ kind: 'field', usage });
const relation = (usage: FieldUsage | null) => fieldDeleteMessage({ kind: 'relation', usage, otherDatabaseName: 'Tasks' });

describe('fieldDeleteMessage (ticket #1311)', () => {
  it('normal stored complete case keeps the existing wording', () => {
    expect(field(u(7, 'record_values'))).toBe("This field has values on 7 record(s). They'll be lost. Delete anyway?");
  });
  it('stored, complete, zero says nothing', () => {
    expect(field(u(0, 'record_values'))).toBeUndefined();
  });
  it('unknown / failed usage says nothing about a count', () => {
    expect(field(null)).toBeUndefined();
    const m = relation(null)!;
    expect(m).toContain('BOTH paired fields');
    expect(m).not.toMatch(/\d/);
  });
  it('computed_values: recalculated, never "lost", no count', () => {
    const m = field(u(40, 'computed_values'))!;
    expect(m).toContain('recalculated');
    expect(m).not.toContain('lost');
    expect(m).not.toContain('40');
  });
  it('derived_from_links: derived, never "lost", even when incomplete', () => {
    for (const complete of [true, false]) {
      const m = field(u(3, 'derived_from_links', complete))!;
      expect(m).toContain('linked records');
      expect(m).not.toContain('lost');
    }
  });
  it('complete:false with count>0 is a floor, not the total', () => {
    const m = field(u(5, 'record_links', false))!;
    expect(m).toContain('at least 5');
    expect(m).toContain("can't see them all");
  });
  it('complete:false with zero is never a confident zero', () => {
    const m = field(u(0, 'record_links', false))!;
    expect(m).toContain("can't see every record");
    expect(m).not.toMatch(/\b0\b/);
  });
  it('relation with links names the count', () => {
    expect(relation(u(12, 'record_links'))).toContain('12 record(s) here hold links');
    expect(relation(u(12, 'record_links'))).toContain('inverse on Tasks');
  });
  it('relation, zero, complete says so plainly', () => {
    expect(relation(u(0, 'record_links'))).toContain('No record here holds a link');
  });
  it('relation incomplete: at least N, and zero is not confident', () => {
    expect(relation(u(4, 'record_links', false))).toContain('At least 4');
    const z = relation(u(0, 'record_links', false))!;
    expect(z).toContain("can't see every record");
    expect(z).not.toContain('No record');
  });
  it('an unrecognised storage kind says nothing rather than guess', () => {
    expect(field(u(9, 'something_new'))).toBeUndefined();
  });
});

describe('parseFieldUsage', () => {
  it('reads the documented shape', () => {
    expect(parseFieldUsage({ records_with_value: 2, storage: 'record_values', complete: true, views: [] })).toEqual(u(2, 'record_values'));
  });
  it('anything short of the full shape is unknown, not zero', () => {
    expect(parseFieldUsage(undefined)).toBeNull();
    expect(parseFieldUsage({ records_with_value: 2 })).toBeNull();
    expect(parseFieldUsage({ records_with_value: 2, storage: 'x' })).toBeNull();
  });
});
