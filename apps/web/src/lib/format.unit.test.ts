// A west-of-UTC clock is where a day-only string used to land on the day before; set it before any Date is made.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { DEFAULT_REGIONAL, formatAge, formatDate, formatDateTime, formatDayLabel, type Regional } from './format';

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

describe('one formatter for every surface (ticket #1275 item 5)', () => {
  it('writes the month and day in the viewer’s locale: en-US "Nov 14", en-GB "14 Nov"', () => {
    const d = new Date(2026, 10, 14);
    expect(formatDate(d, sys, { now: NOW, locale: 'en-US' })).toBe('Nov 14');
    expect(formatDate(d, sys, { now: NOW, locale: 'en-GB' })).toBe('14 Nov');
  });

  it('KEEPS Today, Tomorrow and Yesterday in any locale', () => {
    for (const locale of ['en-US', 'en-GB']) {
      expect(formatDate(new Date(2026, 9, 21), sys, { now: NOW, locale })).toBe('Today');
      expect(formatDate(new Date(2026, 9, 22), sys, { now: NOW, locale })).toBe('Tomorrow');
      expect(formatDate(new Date(2026, 9, 20), sys, { now: NOW, locale })).toBe('Yesterday');
    }
  });

  it('the labels around dates follow the same locale (a calendar title, a timeline axis, a board week heading)', () => {
    const d = new Date(2026, 10, 14);
    expect(formatDayLabel(d, 'monthDay', { locale: 'en-US' })).toBe('Nov 14');
    expect(formatDayLabel(d, 'monthDay', { locale: 'en-GB' })).toBe('14 Nov');
    expect(formatDayLabel(d, 'monthYearLong', { locale: 'en-US' })).toBe('November 2026');
    expect(formatDayLabel(d, 'monthDayYear', { locale: 'en-GB' })).toBe('14 Nov 2026');
    expect(formatDayLabel(d, 'weekdayShort', { locale: 'en-US' })).toBe('Sat');
  });

  it('a UTC date stays the day it names west of UTC (a timeline bucket would read as the day before)', () => {
    expect(formatDayLabel(new Date(Date.UTC(2026, 10, 1)), 'month', { utc: true, locale: 'en-US' })).toBe('Nov');
    expect(formatDayLabel(new Date(Date.UTC(2026, 10, 1)), 'monthDay', { utc: true, locale: 'en-US' })).toBe('Nov 1');
  });

  it('an age is relative inside a day and the shared date words past it, never a bare "12d"', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(formatAge(at(10_000), sys, { now: NOW })).toEqual({ text: 'now', relative: true });
    expect(formatAge(at(5 * 60_000), sys, { now: NOW })).toEqual({ text: '5m', relative: true });
    expect(formatAge(at(3 * 3_600_000), sys, { now: NOW })).toEqual({ text: '3h', relative: true });
    expect(formatAge(new Date(2026, 9, 20, 9), sys, { now: NOW })).toEqual({ text: 'Yesterday', relative: false });
    expect(formatAge(new Date(2026, 9, 9), sys, { now: NOW, locale: 'en-US' })).toEqual({ text: 'Oct 9', relative: false });
    expect(formatAge('not a date', sys, { now: NOW })).toEqual({ text: '', relative: false });
  });
});
