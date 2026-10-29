import { describe, expect, it } from 'vitest';
import { resolveSampleDate } from '@storyos/schemas';
import {
  MAX_RELATIVE_DAYS,
  buildRelativeDate,
  describeRelativeDateCondition,
  formatRelativeDate,
  kindOf,
  parseRelativeDate,
  splitKind,
} from './relative-date';

/**
 * ticket #1155 — the web's reading of the API's relative-date token (`$date:-90d`, ticket #1147 / PR #1335). The first block pins this
 * module to the API's OWN reader, `resolveSampleDate`, over a spread of strings: the web must accept exactly what the API accepts,
 * because a token the web shows as words but the API refuses (or the reverse) is the silent kind of wrong.
 */
describe('parseRelativeDate agrees with the API reader (resolveSampleDate)', () => {
  const samples = [
    '$date:-90d', '$date:+3d', '$date:-0d', '$date:+0d', '$date:-1d', '$date:+9999d', '$date:-9999d', '$date:-10000d',
    '$date:90d', '$date:-90', '$date:-ninety', '$date:-90D', '$date:-9 0d', ' $date:-90d', '$date:-90d ', '$date:--90d', '$date:',
    '2026-07-31', '', 'today', '$sample:Clients/Acme',
  ];
  it.each(samples)('%j: web parses it iff the API resolves it', (s) => {
    expect(parseRelativeDate(s) !== null).toBe(resolveSampleDate(s) !== null);
  });
  it('a token the web builds is one the API resolves', () => {
    for (const unit of ['days', 'weeks'] as const) {
      for (const direction of ['ago', 'ahead'] as const) {
        const t = buildRelativeDate(5, unit, direction)!;
        expect(resolveSampleDate(t)).not.toBeNull();
      }
    }
  });
});

describe('parseRelativeDate', () => {
  it('reads days, and whole weeks as weeks', () => {
    expect(parseRelativeDate('$date:-90d')).toEqual({ amount: 90, unit: 'days', direction: 'ago' });
    expect(parseRelativeDate('$date:+3d')).toEqual({ amount: 3, unit: 'days', direction: 'ahead' });
    expect(parseRelativeDate('$date:-14d')).toEqual({ amount: 2, unit: 'weeks', direction: 'ago' });
    expect(parseRelativeDate('$date:+7d')).toEqual({ amount: 1, unit: 'weeks', direction: 'ahead' });
    expect(parseRelativeDate('$date:-6d')).toEqual({ amount: 6, unit: 'days', direction: 'ago' });
  });
  it('is null for anything that is not exactly the token: it never throws and never guesses', () => {
    for (const v of ['2026-07-31', '', null, undefined, 42, ['$date:-90d'], { a: 1 }, '$date:-ninety', '$date:-90', 'next_7_days']) {
      expect(parseRelativeDate(v)).toBeNull();
    }
  });
});

describe('buildRelativeDate', () => {
  it('writes the API token; weeks are seven days each', () => {
    expect(buildRelativeDate(90, 'days', 'ago')).toBe('$date:-90d');
    expect(buildRelativeDate(3, 'days', 'ahead')).toBe('$date:+3d');
    expect(buildRelativeDate(2, 'weeks', 'ago')).toBe('$date:-14d');
    expect(buildRelativeDate(1, 'weeks', 'ahead')).toBe('$date:+7d');
  });
  it('refuses what the API would: zero, negative, fractional, NaN, and past four digits of days', () => {
    expect(buildRelativeDate(0, 'days', 'ago')).toBeNull();
    expect(buildRelativeDate(-3, 'days', 'ago')).toBeNull();
    expect(buildRelativeDate(1.5, 'days', 'ago')).toBeNull();
    expect(buildRelativeDate(NaN, 'days', 'ago')).toBeNull();
    expect(buildRelativeDate(MAX_RELATIVE_DAYS, 'days', 'ago')).toBe('$date:-9999d');
    expect(buildRelativeDate(MAX_RELATIVE_DAYS + 1, 'days', 'ago')).toBeNull();
    expect(buildRelativeDate(1429, 'weeks', 'ago')).toBeNull(); // 10003 days
    expect(buildRelativeDate(1428, 'weeks', 'ago')).toBe('$date:-9996d');
  });
  it('round-trips: what is authored reads back as the same token', () => {
    for (const unit of ['days', 'weeks'] as const) {
      for (const direction of ['ago', 'ahead'] as const) {
        for (const amount of [1, 2, 7, 8, 14, 90, 365]) {
          const t = buildRelativeDate(amount, unit, direction)!;
          const r = parseRelativeDate(t)!;
          expect(buildRelativeDate(r.amount, r.unit, r.direction)).toBe(t);
        }
      }
    }
  });
});

describe('formatRelativeDate', () => {
  it('says it in words, singular where it is one', () => {
    expect(formatRelativeDate('$date:-90d')).toBe('90 days ago');
    expect(formatRelativeDate('$date:+3d')).toBe('3 days from now');
    expect(formatRelativeDate('$date:-1d')).toBe('1 day ago');
    expect(formatRelativeDate('$date:+7d')).toBe('1 week from now');
    expect(formatRelativeDate('$date:-21d')).toBe('3 weeks ago');
    expect(formatRelativeDate('$date:+0d')).toBe('today');
  });
  it('is null for an absolute date, so the caller keeps showing the date', () => {
    expect(formatRelativeDate('2026-07-31')).toBeNull();
    expect(formatRelativeDate('')).toBeNull();
  });
});

describe('describeRelativeDateCondition: the phrase is exact, never the nearest friendly one', () => {
  it('before N days ago is "more than N days ago"; after N days from now is "more than N days from now"', () => {
    expect(describeRelativeDateCondition('before', '$date:-90d')).toBe('more than 90 days ago');
    expect(describeRelativeDateCondition('after', '$date:+3d')).toBe('more than 3 days from now');
  });
  it('the other pairings keep the operator, because no shorter phrase is true of them', () => {
    expect(describeRelativeDateCondition('after', '$date:-90d')).toBe('after 90 days ago');
    expect(describeRelativeDateCondition('before', '$date:+3d')).toBe('before 3 days from now');
    expect(describeRelativeDateCondition('before', '$date:+0d')).toBe('before today');
  });
  it('is null for an absolute date, an unknown token, or an op that does not take a token (the API refuses eq/neq)', () => {
    expect(describeRelativeDateCondition('before', '2026-07-31')).toBeNull();
    expect(describeRelativeDateCondition('before', '$date:-ninety')).toBeNull();
    expect(describeRelativeDateCondition('eq', '$date:-90d')).toBeNull();
    expect(describeRelativeDateCondition('is_empty', '$date:-90d')).toBeNull();
  });
});

describe('the authoring menu', () => {
  it('kindOf / splitKind agree, and an absolute value is the exact-date kind', () => {
    expect(kindOf(parseRelativeDate('2026-07-31'))).toBe('date');
    expect(splitKind('date')).toBeNull();
    for (const t of ['$date:-90d', '$date:+3d', '$date:-14d', '$date:+14d']) {
      const r = parseRelativeDate(t)!;
      expect(splitKind(kindOf(r))).toEqual({ unit: r.unit, direction: r.direction });
    }
  });
});
