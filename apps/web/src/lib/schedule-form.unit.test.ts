import { describe, expect, it } from 'vitest';
import { halfHourTimes, minutesDraft, minutesHelper } from './schedule-form';

/** Ticket #1318 — the interval box and the time menu. Pins what must be ACCEPTED as well as what is refused. */
describe('#1318 minutesDraft', () => {
  it('accepts a whole number from 10 to 1440, edges included', () => {
    for (const ok of ['10', '30', '45', '720', '1440', ' 60 ']) {
      const d = minutesDraft(ok);
      expect(d.error, ok).toBeNull();
      expect(d.value, ok).toBe(Number(ok.trim()));
    }
  });

  it('refuses under 10 with the API\'s own sentence, shortened to its first clause', () => {
    for (const bad of ['9', '5', '0', '-30']) {
      const d = minutesDraft(bad);
      expect(d.value, bad).toBeNull();
      expect(d.error, bad).toBe('A schedule can run at most every 10 minutes.');
    }
  });

  it('refuses over a day with the API\'s wording, which points at "every day"', () => {
    const d = minutesDraft('1441');
    expect(d.value).toBeNull();
    expect(d.error).toMatch(/at most 1440/);
  });

  it('refuses an empty box, a decimal and text, each with a sentence of its own', () => {
    expect(minutesDraft('').error).toMatch(/Enter how many minutes/);
    expect(minutesDraft('   ').value).toBeNull();
    expect(minutesDraft('12.5').error).toMatch(/whole number/);
    expect(minutesDraft('abc').error).toMatch(/whole number/);
  });
});

describe('#1318 halfHourTimes', () => {
  it('is the 48 half-hour steps of a day', () => {
    const t = halfHourTimes();
    expect(t).toHaveLength(48);
    expect(t[0]).toBe('00:00');
    expect(t[1]).toBe('00:30');
    expect(t[47]).toBe('23:30');
  });
  it('lists a saved time that is off the grid as its own first option, and does not repeat one that is on it', () => {
    expect(halfHourTimes('09:10')[0]).toBe('09:10');
    expect(halfHourTimes('09:10')).toHaveLength(49);
    expect(halfHourTimes('09:30')).toHaveLength(48);
    expect(halfHourTimes('9am')).toHaveLength(48);
  });
});

describe('#1318 minutesHelper', () => {
  it('names the minute marks when N divides the hour', () => {
    expect(minutesHelper(30, 'Europe/London')).toBe('Runs at :00 and :30 past the hour in Europe/London.');
    expect(minutesHelper(15, 'UTC')).toBe('Runs at :00, :15, :30 and :45 past the hour in UTC.');
    expect(minutesHelper(60, 'UTC')).toBe('Runs at :00 past the hour in UTC.');
  });
  it('shifts the marks to where an active window starts', () => {
    expect(minutesHelper(30, 'UTC', '09:10')).toBe('Runs at :10 and :40 past the hour in UTC.');
  });
  it('says it drifts across the hour when N does not divide it', () => {
    expect(minutesHelper(45, 'UTC')).toBe('Runs every 45 minutes from midnight in UTC.');
    expect(minutesHelper(90, 'UTC', '08:00')).toBe('Runs every 90 minutes from 08:00 in UTC.');
  });
});
