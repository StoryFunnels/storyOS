import { describe, expect, it } from 'vitest';
import type { SourceRecurrence } from '@storyos/schemas';
import { isRecurrenceDue, previousSlot, scheduleFromRecurrence } from './recurrence';

/** #340 — the wall-clock recurrence engine. Pure math, no DB. */
describe('source recurrence — previousSlot (UTC)', () => {
  it('hourly: most recent :minute past the hour', () => {
    const daily = (kind: 'hourly', minute: number): SourceRecurrence => ({ kind, minute });
    // 10:20 with minute=15 → this hour's :15 already passed → 10:15.
    expect(previousSlot(daily('hourly', 15), new Date('2026-07-25T10:20:00Z')).toISOString()).toBe(
      '2026-07-25T10:15:00.000Z',
    );
    // 10:10 with minute=15 → this hour's :15 hasn't happened → 09:15.
    expect(previousSlot(daily('hourly', 15), new Date('2026-07-25T10:10:00Z')).toISOString()).toBe(
      '2026-07-25T09:15:00.000Z',
    );
  });

  it('daily: most recent hour:minute of the day', () => {
    const rec: SourceRecurrence = { kind: 'daily', hour: 9, minute: 0 };
    // After 09:00 → today 09:00.
    expect(previousSlot(rec, new Date('2026-07-25T12:00:00Z')).toISOString()).toBe(
      '2026-07-25T09:00:00.000Z',
    );
    // Before 09:00 → yesterday 09:00.
    expect(previousSlot(rec, new Date('2026-07-25T06:00:00Z')).toISOString()).toBe(
      '2026-07-24T09:00:00.000Z',
    );
  });

  it('weekly: most recent weekday at hour:minute', () => {
    // 2026-07-25 is a Saturday (getUTCDay 6). Target Monday (1) at 08:30.
    const rec: SourceRecurrence = { kind: 'weekly', weekday: 1, hour: 8, minute: 30 };
    // From Saturday → most recent Monday is 2026-07-20.
    expect(previousSlot(rec, new Date('2026-07-25T12:00:00Z')).toISOString()).toBe(
      '2026-07-20T08:30:00.000Z',
    );
  });

  it('weekly: same weekday but before the time-of-day rewinds a full week', () => {
    // 2026-07-20 is a Monday. Target Monday 08:30, but it is 07:00 → last week.
    const rec: SourceRecurrence = { kind: 'weekly', weekday: 1, hour: 8, minute: 30 };
    expect(previousSlot(rec, new Date('2026-07-20T07:00:00Z')).toISOString()).toBe(
      '2026-07-13T08:30:00.000Z',
    );
  });
});

describe('source recurrence — isRecurrenceDue', () => {
  const rec: SourceRecurrence = { kind: 'daily', hour: 9, minute: 0 };

  it('never-synced sources are always due', () => {
    expect(isRecurrenceDue(rec, null, new Date('2026-07-25T09:30:00Z'))).toBe(true);
  });

  it('due once the wall-clock slot passes since last sync', () => {
    const now = new Date('2026-07-25T09:30:00Z');
    // Last synced yesterday → today's 09:00 slot has passed → due.
    expect(isRecurrenceDue(rec, new Date('2026-07-24T09:05:00Z'), now)).toBe(true);
    // Already synced after today's 09:00 slot → not due until tomorrow.
    expect(isRecurrenceDue(rec, new Date('2026-07-25T09:05:00Z'), now)).toBe(false);
  });

  it('does not fire again within the same slot window (fixed wall-clock, not "every N minutes")', () => {
    const rec2: SourceRecurrence = { kind: 'hourly', minute: 0 };
    const now = new Date('2026-07-25T10:59:00Z');
    // Synced at 10:00 (this hour's slot) → not due again until 11:00.
    expect(isRecurrenceDue(rec2, new Date('2026-07-25T10:00:30Z'), now)).toBe(false);
    // A minute later, past 11:00, becomes due.
    expect(isRecurrenceDue(rec2, new Date('2026-07-25T10:00:30Z'), new Date('2026-07-25T11:00:10Z'))).toBe(
      true,
    );
  });
});

describe('source recurrence — scheduleFromRecurrence (legacy shadow)', () => {
  it('maps each kind to a coarse schedule for the not-null column', () => {
    expect(scheduleFromRecurrence({ kind: 'hourly', minute: 0 })).toBe('hour');
    expect(scheduleFromRecurrence({ kind: 'daily', hour: 9, minute: 0 })).toBe('day');
    expect(scheduleFromRecurrence({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 })).toBe('day');
  });
});
