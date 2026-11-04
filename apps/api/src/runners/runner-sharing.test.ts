import { describe, expect, it } from 'vitest';
import { holdFor, holdsFor, hoursState, planUsage, reserveMeasurable, workingHoursSchema } from './runner-sharing';
import type { WorkingHours } from './runner-sharing';

/** ticket #1137: the pure rules, with a clock the test owns. Every instant below is an explicit UTC time. */
const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const night = (tz: string, days = ALL): WorkingHours => ({ days, start: '22:00', end: '06:00', timezone: tz });
const at = (iso: string) => new Date(iso);

describe('working hours', () => {
  it('a daytime window: open inside, closed outside with the next opening, closed at the exact end', () => {
    const h: WorkingHours = { days: ALL, start: '09:00', end: '17:00', timezone: 'UTC' };
    expect(hoursState(h, at('2027-01-13T10:00:00Z'))).toMatchObject({ open: true, closes_at: at('2027-01-13T17:00:00Z') });
    expect(hoursState(h, at('2027-01-13T17:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-01-14T09:00:00Z') });
    expect(hoursState(h, at('2027-01-13T08:59:59Z'))).toMatchObject({ open: false, resumes_at: at('2027-01-13T09:00:00Z') });
    expect(hoursState(h, at('2027-01-13T09:00:00Z'))).toMatchObject({ open: true });
  });

  it('an overnight window belongs to the day it starts: Monday 22:00-06:00 is open at 02:00 Tuesday and not at 02:00 Monday', () => {
    const h = night('UTC', ['mon']);
    // 2027-01-11 is a Monday.
    expect(hoursState(h, at('2027-01-11T23:00:00Z'))).toMatchObject({ open: true, closes_at: at('2027-01-12T06:00:00Z') });
    expect(hoursState(h, at('2027-01-12T02:00:00Z'))).toMatchObject({ open: true });
    expect(hoursState(h, at('2027-01-11T02:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-01-11T22:00:00Z') });
    expect(hoursState(h, at('2027-01-12T23:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-01-18T22:00:00Z') });
  });

  it('the window is wall-clock time in its zone: Kyiv 22:00 is 20:00Z in winter and 19:00Z in summer', () => {
    const h = night('Europe/Kyiv');
    expect(hoursState(h, at('2027-01-13T12:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-01-13T20:00:00Z') });
    expect(hoursState(h, at('2027-07-13T12:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-07-13T19:00:00Z') });
  });

  it('DST: the spring-forward and fall-back nights still close at 06:00 on the wall clock', () => {
    const h = night('America/New_York');
    // 2027-03-14: 02:00 EST -> 03:00 EDT. Window 22:00 Sat -> 06:00 Sun spans it; 06:00 EDT = 10:00Z (not 11:00Z).
    const open = hoursState(h, at('2027-03-14T05:00:00Z'));
    expect(open).toMatchObject({ open: true });
    if (open.open) expect(open.closes_at).toEqual(at('2027-03-14T10:00:00Z'));
    expect(hoursState(h, at('2027-03-14T18:00:00Z'))).toMatchObject({ open: false, resumes_at: at('2027-03-15T02:00:00Z') });
    // 2027-11-07: 02:00 EDT -> 01:00 EST. Window closes 06:00 EST = 11:00Z.
    const fall = hoursState(h, at('2027-11-07T03:00:00Z'));
    expect(fall).toMatchObject({ open: true });
    if (fall.open) expect(fall.closes_at).toEqual(at('2027-11-07T11:00:00Z'));
  });

  it('a wall time that does not exist (02:30 on the spring-forward night) opens right after the gap', () => {
    const h: WorkingHours = { days: ALL, start: '02:30', end: '04:00', timezone: 'America/New_York' };
    const s = hoursState(h, at('2027-03-14T05:00:00Z'));
    expect(s.open).toBe(false);
    if (!s.open) {
      expect(s.resumes_at.getTime()).toBeGreaterThanOrEqual(at('2027-03-14T07:00:00Z').getTime());
      expect(s.resumes_at.getTime()).toBeLessThanOrEqual(at('2027-03-14T07:30:00Z').getTime());
    }
  });

  it('validation: needs a day, real HH:MM, a real zone, and start != end', () => {
    expect(workingHoursSchema.safeParse({ days: ['mon'], start: '22:00', end: '06:00', timezone: 'Europe/Kyiv' }).success).toBe(true);
    for (const bad of [
      { days: [], start: '22:00', end: '06:00', timezone: 'UTC' },
      { days: ['mon'], start: '25:00', end: '06:00', timezone: 'UTC' },
      { days: ['mon'], start: '22:00', end: '22:00', timezone: 'UTC' },
      { days: ['mon'], start: '22:00', end: '06:00', timezone: 'Mars/Olympus' },
      { days: ['funday'], start: '22:00', end: '06:00', timezone: 'UTC' },
    ]) {
      expect(workingHoursSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the reserve is only as real as what the tool reports', () => {
  const claude = { id: 'claude-code', installed: true };
  const reporting = (used: number, resets?: string) => ({ id: 'meter', installed: true, capabilities: { plan_usage_percent: used, ...(resets ? { plan_usage_resets_at: resets } : {}) } });

  it('a tool that reports no plan usage is not measurable, and a reserve on it holds nothing back (never a faked zero)', () => {
    expect(reserveMeasurable(claude)).toBe(false);
    expect(planUsage(claude)).toBeNull();
    expect(planUsage({ id: 'x', capabilities: { plan_usage_percent: 'lots' } })).toBeNull();
    expect(holdsFor({ pausedUntil: null, sharing: { reserve_percent: 30 }, chosenTool: 'claude-code', tools: [claude] }, at('2027-01-13T10:00:00Z'))).toEqual([]);
  });

  it('a reporting tool: holds once usage passes 100 - reserve (exactly at the line is allowed), lifts at the reported reset', () => {
    const now = at('2027-01-13T10:00:00Z');
    const r = (used: number, resets?: string) => ({ pausedUntil: null, sharing: { reserve_percent: 30 }, chosenTool: 'meter', tools: [reporting(used, resets)] });
    expect(holdFor(r(70), now)).toBeNull();
    expect(holdFor(r(69), now)).toBeNull();
    expect(holdFor(r(71, '2027-01-13T15:00:00Z'), now)).toEqual({ reason: 'reserve', resumes_at: at('2027-01-13T15:00:00Z') });
    expect(holdFor(r(95), now)).toEqual({ reason: 'reserve', resumes_at: null });
    expect(holdFor(r(95, '2027-01-13T09:00:00Z'), now)).toEqual({ reason: 'reserve', resumes_at: null });
  });
});

describe('one answer when several rules apply', () => {
  it('the limit pause and closed hours: the later time wins; it resumes when both lift', () => {
    const wh: WorkingHours = { days: ALL, start: '09:00', end: '17:00', timezone: 'UTC' };
    const r = { pausedUntil: at('2027-01-13T20:00:00Z'), sharing: { working_hours: wh }, chosenTool: 'claude-code', tools: [{ id: 'claude-code', installed: true }] };
    expect(holdsFor(r, at('2027-01-13T12:00:00Z')).map((h) => h.reason)).toEqual(['limit_reached']);
    expect(holdFor(r, at('2027-01-13T18:00:00Z'))).toEqual({ reason: 'working_hours', resumes_at: at('2027-01-14T09:00:00Z') });
    expect(holdFor(r, at('2027-01-14T10:00:00Z'))).toBeNull();
  });
});
