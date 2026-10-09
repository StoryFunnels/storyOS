import { describe, expect, it } from 'vitest';
import { VISIBILITY_CHIP, VISIBILITY_OPTIONS, initials, relativeTime, runLine } from './skill-meta';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('relativeTime', () => {
  it('is coarse and never negative', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d ago');
    expect(relativeTime(ago(71 * 86_400_000), NOW)).toBe('2mo ago');
    expect(relativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe('just now');
  });
  it('says so when the timestamp is unreadable rather than printing NaN', () => {
    expect(relativeTime('not a date', NOW)).toBe('unknown');
  });
});

describe('runLine', () => {
  it('reports "never run" distinctly from a run', () => {
    expect(runLine({ last_run_at: null, last_run_status: null }, NOW)).toEqual({ text: 'never run', failed: false });
  });
  it('flags a failed run, and says ok for a good one', () => {
    expect(runLine({ last_run_at: ago(2 * 86_400_000), last_run_status: 'ok' }, NOW)).toEqual({ text: 'ran 2d ago · ok', failed: false });
    expect(runLine({ last_run_at: ago(2 * 86_400_000), last_run_status: 'error' }, NOW)).toEqual({ text: 'ran 2d ago · failed', failed: true });
  });
});

describe('visibility wording (Otto\'s ruling: the word "private" never appears)', () => {
  it('uses "Only me" on the chip and spells out admins in the picker', () => {
    expect(VISIBILITY_CHIP.personal).toBe('Only me');
    expect(VISIBILITY_OPTIONS.find((o) => o.value === 'personal')!.label).toBe('Only me — you and workspace admins');
  });
  it('never says "private" anywhere a user reads', () => {
    const all = JSON.stringify([VISIBILITY_CHIP, VISIBILITY_OPTIONS]).toLowerCase();
    expect(all).not.toContain('private');
  });
  it('lists workspace first: it is the default (parent ticket #832)', () => {
    expect(VISIBILITY_OPTIONS[0]!.value).toBe('shared');
  });
});

describe('initials', () => {
  it('takes first and last initial, and survives a missing name', () => {
    expect(initials('Ievgen Krasovytskyi')).toBe('IK');
    expect(initials('Madonna')).toBe('M');
    expect(initials(undefined)).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
