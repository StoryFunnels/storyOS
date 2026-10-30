import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { FieldDef } from '@storyos/schemas';
import { compileFilter } from '../src/records/query-compiler';

/**
 * ticket #1147 — `before` / `after` take a relative date (`$date:-90d`), resolved when the filter is COMPILED, against the clock of that
 * moment. Views, a scheduled automation's selection and an automation condition all compile through `compileFilter`, so this is the one
 * place the clock is read. The clock is controlled here, so the bound is asserted exactly rather than "about 90 days ago".
 */
const reviewed: FieldDef = { id: 'f-1', api_name: 'last_reviewed', type: 'date', config: {} };
const created: FieldDef = { id: 'f-2', api_name: 'created_at', type: 'created_at', config: {} };
const ctx = { defs: new Map([['last_reviewed', reviewed], ['created_at', created]]), currentUserId: 'u' };
const dialect = new PgDialect();
// the compared value is the last bound parameter (the field id comes first)
const params = (filter: Parameters<typeof compileFilter>[0]) => [dialect.sqlToQuery(compileFilter(filter, ctx)).params.at(-1)];

afterEach(() => vi.useRealTimers());

describe('#1147 a relative date in before/after', () => {
  it('before $date:-90d on a date field binds the date 90 days before the clock, and it moves with the clock', () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
    expect(params({ field: 'last_reviewed', op: 'before', value: '$date:-90d' })).toEqual(['2026-07-31']);
    vi.setSystemTime(new Date('2027-01-10T23:59:00Z'));
    expect(params({ field: 'last_reviewed', op: 'before', value: '$date:-90d' })).toEqual(['2026-10-12']);
  });

  it('after $date:+3d works the same way, and a static ISO date is untouched', () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
    expect(params({ field: 'last_reviewed', op: 'after', value: '$date:+3d' })).toEqual(['2026-11-01']);
    expect(params({ field: 'last_reviewed', op: 'before', value: '2026-01-02' })).toEqual(['2026-01-02']);
  });

  it('on a timestamp column (created_at) the token becomes a Date at that day\'s midnight, UTC', () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
    expect(params({ field: 'created_at', op: 'before', value: '$date:-90d' })).toEqual([new Date('2026-07-31T00:00:00Z')]);
  });

  it('is refused on anything it is not defined for: a malformed token, or eq/neq (a token means a day, not a range)', () => {
    expect(() => params({ field: 'last_reviewed', op: 'before', value: '$date:-ninety' })).toThrow(/ISO date/);
    expect(() => params({ field: 'last_reviewed', op: 'before', value: '$date:-90' })).toThrow(/ISO date/);
    expect(() => params({ field: 'last_reviewed', op: 'eq', value: '$date:-90d' })).toThrow(/ISO date/);
  });
});
