import { describe, expect, it } from 'vitest';
import { dayPart, firstName, greeting } from './greeting';

const at = (h: number, m: number) => new Date(2026, 10, 13, h, m, 0);

describe('dayPart (ticket #1274) — boundaries on the browser clock', () => {
  it.each([
    [4, 59, 'evening'],
    [5, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'afternoon'],
    [17, 59, 'afternoon'],
    [18, 0, 'evening'],
    [0, 0, 'evening'],
    [23, 59, 'evening'],
  ] as const)('%i:%i is %s', (h, m, want) => {
    expect(dayPart(at(h, m))).toBe(want);
  });
});

describe('firstName', () => {
  it('takes the first word of the display name', () => {
    expect(firstName('Ana')).toBe('Ana');
    expect(firstName('Ana Maria Lopez')).toBe('Ana');
  });
  it('ignores surrounding and repeated whitespace', () => {
    expect(firstName('   Ana    Lopez  ')).toBe('Ana');
  });
  it('has no name for empty, blank, null or undefined', () => {
    expect(firstName('')).toBeNull();
    expect(firstName('   ')).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(firstName(undefined)).toBeNull();
  });
});

describe('greeting', () => {
  it('joins the part of day and the first name', () => {
    expect(greeting(at(14, 0), 'Ana Maria Lopez')).toBe('Good afternoon, Ana');
    expect(greeting(at(5, 0), '  Ana   Lopez ')).toBe('Good morning, Ana');
  });
  it('drops ", <name>" entirely when there is no name — no dangling comma', () => {
    expect(greeting(at(19, 0), null)).toBe('Good evening');
    expect(greeting(at(9, 0), '')).toBe('Good morning');
    expect(greeting(at(9, 0), '   ')).toBe('Good morning');
  });
});
