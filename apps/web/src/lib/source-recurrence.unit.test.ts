import { describe, expect, it } from 'vitest';
import {
  buildRecurrence,
  describeRecurrence,
  DEFAULT_RECURRENCE_FORM,
  type RecurrenceFormState,
} from './source-recurrence';

describe('buildRecurrence — form state → API body', () => {
  it('daily uses the picked time of day', () => {
    expect(buildRecurrence({ ...DEFAULT_RECURRENCE_FORM, kind: 'daily', timeOfDay: '14:30' })).toEqual({
      kind: 'daily',
      hour: 14,
      minute: 30,
    });
  });

  it('weekly carries the weekday plus time', () => {
    const form: RecurrenceFormState = { kind: 'weekly', timeOfDay: '08:05', weekday: 3, minute: 0 };
    expect(buildRecurrence(form)).toEqual({ kind: 'weekly', weekday: 3, hour: 8, minute: 5 });
  });

  it('hourly carries only the minute and ignores time-of-day', () => {
    const form: RecurrenceFormState = { kind: 'hourly', timeOfDay: '09:00', weekday: 1, minute: 45 };
    expect(buildRecurrence(form)).toEqual({ kind: 'hourly', minute: 45 });
  });

  it('clamps out-of-range values defensively', () => {
    expect(buildRecurrence({ ...DEFAULT_RECURRENCE_FORM, kind: 'daily', timeOfDay: '99:99' })).toEqual({
      kind: 'daily',
      hour: 23,
      minute: 59,
    });
    expect(buildRecurrence({ kind: 'hourly', timeOfDay: '', weekday: 0, minute: 120 })).toEqual({
      kind: 'hourly',
      minute: 59,
    });
  });

  it('the default form is a daily-09:00 recurrence', () => {
    expect(buildRecurrence(DEFAULT_RECURRENCE_FORM)).toEqual({ kind: 'daily', hour: 9, minute: 0 });
  });
});

describe('describeRecurrence — human label', () => {
  it('labels each recurrence kind', () => {
    expect(describeRecurrence({ kind: 'daily', hour: 9, minute: 0 }, 'day')).toBe('Daily at 09:00 UTC');
    expect(describeRecurrence({ kind: 'hourly', minute: 5 }, 'hour')).toBe('Hourly at :05');
    expect(describeRecurrence({ kind: 'weekly', weekday: 1, hour: 8, minute: 30 }, 'day')).toBe(
      'Weekly on Monday at 08:30 UTC',
    );
  });

  it('falls back to the legacy schedule string when there is no recurrence', () => {
    expect(describeRecurrence(null, '15m')).toBe('Every 15 minutes');
    expect(describeRecurrence(null, 'hour')).toBe('Hourly');
    expect(describeRecurrence(undefined, 'day')).toBe('Daily');
  });
});
