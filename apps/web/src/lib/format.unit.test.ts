// A west-of-UTC clock is where a day-only string used to land on the day before; set it before any Date is made.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { DEFAULT_REGIONAL, formatDate, formatDateTime, type Regional } from './format';

const NOW = new Date(2026, 9, 21, 12, 0); // Wed 21 Oct 2026, noon local
const sys: Regional = DEFAULT_REGIONAL;
const month = (d: Date, withYear = false) =>
  d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });

describe('formatDate, the friendly (system) form (#1005)', () => {
  it('says Today, Tomorrow and Yesterday for the near days', () => {
    expect(formatDate(new Date(2026, 9, 21, 23, 59), sys, { now: NOW })).toBe('Today');
    expect(formatDate(new Date(2026, 9, 22, 0, 1), sys, { now: NOW })).toBe('Tomorrow');
    expect(formatDate(new Date(2026, 9, 20, 23, 59), sys, { now: NOW })).toBe('Yesterday');
  });

  it('is day-based, not 24-hour-based: 23:59 today and 00:01 tomorrow are different words', () => {
    expect(formatDate(new Date(2026, 9, 21, 0, 0), sys, { now: new Date(2026, 9, 21, 23, 59) })).toBe('Today');
    expect(formatDate(new Date(2026, 9, 22, 0, 0), sys, { now: new Date(2026, 9, 21, 23, 59) })).toBe('Tomorrow');
  });

  it('this year is the day and the month, in the viewer’s locale, with no year', () => {
    const d = new Date(2026, 9, 18);
    const out = formatDate(d, sys, { now: NOW });
    expect(out).toBe(month(d));
    expect(out).not.toMatch(/2026/);
    expect(out).toMatch(/Oct/);
  });

  it('another year adds the year', () => {
    const d = new Date(2025, 9, 18);
    expect(formatDate(d, sys, { now: NOW })).toBe(month(d, true));
    expect(formatDate(d, sys, { now: NOW })).toMatch(/2025/);
  });

  it('crosses a year boundary by the calendar: 1 Jan is Tomorrow on 31 Dec', () => {
    expect(formatDate(new Date(2027, 0, 1), sys, { now: new Date(2026, 11, 31, 9) })).toBe('Tomorrow');
  });

  it('a preview of the format turns the relative words off, so it shows the shape rather than "Today"', () => {
    expect(formatDate(NOW, sys, { now: NOW, relative: false })).toBe(month(NOW));
  });

  it('a day-only value is a CALENDAR DAY: "2026-10-21" is the 21st on a clock west of UTC, not the 20th', () => {
    expect(formatDate('2026-10-21', sys, { now: NOW })).toBe('Today');
    expect(formatDate('2026-10-22T00:00:00.000Z', sys, { now: NOW })).toBe('Tomorrow');
    expect(formatDate('2026-10-18', sys, { now: NOW })).toBe(month(new Date(2026, 9, 18)));
  });

  it('empty and unparseable values show nothing rather than "Invalid Date"', () => {
    expect(formatDate(null, sys)).toBe('');
    expect(formatDate('', sys)).toBe('');
    expect(formatDate('not a date', sys)).toBe('');
  });
});

describe('an explicit date format is a choice, and is kept', () => {
  it.each([
    ['MDY', '10/18/2026'],
    ['DMY', '18/10/2026'],
    ['YMD', '2026-10-18'],
  ] as const)('%s stays numerals, whatever today is', (dateFormat, expected) => {
    expect(formatDate(new Date(2026, 9, 18), { ...sys, dateFormat }, { now: NOW })).toBe(expected);
    expect(formatDate(NOW, { ...sys, dateFormat }, { now: NOW })).toBe(
      formatDate(NOW, { ...sys, dateFormat }, { now: new Date(2030, 0, 1) }),
    );
  });
});

describe('formatDateTime', () => {
  it('adds the time after the friendly day, in the 24h clock when asked', () => {
    const out = formatDateTime(new Date(2026, 9, 22, 14, 30), { ...sys, timeFormat: '24h' }, { now: NOW });
    expect(out).toBe('Tomorrow, 14:30');
  });
  it('uses the 12-hour clock when asked', () => {
    const out = formatDateTime(new Date(2026, 9, 22, 14, 30), { ...sys, timeFormat: '12h' }, { now: NOW });
    expect(out).toMatch(/^Tomorrow, 0?2:30\s?PM$/i);
  });
});
