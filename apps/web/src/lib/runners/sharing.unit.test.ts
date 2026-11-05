import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// The API's OWN schema (apps/api/src/runners/runner-sharing.ts), not a copy: every value this screen can send is run through it.
import { reservePercentSchema, workingHoursSchema } from '../../../../api/src/runners/runner-sharing';
import { SharingSection } from '@/components/runners/sharing-section';
import { apiErrorMessage } from '@/lib/api';
import { canUseRunners } from './access';
import {
  canEditSharing,
  daysPhrase,
  defaultHours,
  hoursBody,
  hoursProblem,
  hoursSummary,
  hoursSwitch,
  RESERVE_STEPS,
  reserveOptions,
  reserveSwitch,
  reserveView,
  RESERVE_UNMEASURABLE_FALLBACK,
  TIME_STEPS,
  timeOptions,
  toggleDay,
  validReserve,
  windowPhrase,
  zoneSentence,
} from './sharing';
import { describeHold, describeRun, describeRunner } from './status';
import type { RunnerDto, WakeDto, WorkingDay } from './types';
import { resumeWhen } from './words';

const TZ = { timeZone: 'UTC' };
const NOW = new Date('2026-10-29T14:00:00Z'); // a Thursday
const runner = (over: Partial<RunnerDto> = {}): RunnerDto => ({
  id: 'r1',
  name: 'MacBook',
  status: 'active',
  connection: 'online',
  tools: [{ id: 'claude-code', name: 'Claude Code', installed: true, reserve_measurable: false }],
  chosen_tool: 'claude-code',
  runner_version: '0.0.1',
  protocol_version: 1,
  paired_at: '2026-10-29T09:00:00Z',
  last_seen_at: '2026-10-29T13:59:00Z',
  offline_since: null,
  paused_until: null,
  pause_reason: null,
  pending_expires_at: null,
  agents: [],
  ...over,
});

describe('working hours: the model the API accepts', () => {
  const ok = { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as WorkingDay[], start: '09:00', end: '18:00', timezone: 'Europe/Madrid' };
  it('serialises to exactly the API shape, days in week order, and the API schema accepts it', () => {
    const body = hoursBody({ ...ok, days: ['fri', 'mon', 'wed'] });
    expect(body).toEqual({ days: ['mon', 'wed', 'fri'], start: '09:00', end: '18:00', timezone: 'Europe/Madrid' });
    expect(workingHoursSchema.safeParse(body).success).toBe(true);
  });
  it('an overnight window (end before start) is valid, is said to be overnight, and the API accepts it', () => {
    const h = { ...ok, start: '22:00', end: '06:00' };
    expect(hoursProblem(h)).toBeNull();
    expect(windowPhrase(h)).toBe('Mon to Fri, 22:00 to 06:00, overnight');
    expect(workingHoursSchema.safeParse(hoursBody(h)).success).toBe(true);
    expect(windowPhrase(ok)).not.toContain('overnight');
  });
  it('start equal to end is refused on the screen with a sentence, and nothing is sent (the API would 422)', () => {
    const h = { ...ok, start: '09:00', end: '09:00' };
    expect(hoursProblem(h)).toMatch(/same time/);
    expect(hoursBody(h)).toBeNull();
    expect(workingHoursSchema.safeParse(h).success).toBe(false);
  });
  it('no day chosen is a problem the screen names, not a request (the API would 422)', () => {
    const h = { ...ok, days: [] };
    expect(hoursProblem(h)).toMatch(/at least one day/);
    expect(hoursBody(h)).toBeNull();
    expect(workingHoursSchema.safeParse(h).success).toBe(false);
  });
  it('EVERY start/end the menus offer, with any days, is accepted by the API unless start equals end, and then the screen refuses it first', () => {
    let accepted = 0;
    for (const start of TIME_STEPS)
      for (const end of TIME_STEPS) {
        const h = { days: ['sat' as const], start, end, timezone: 'UTC' };
        const api = workingHoursSchema.safeParse(h).success;
        expect(api, `${start}-${end}`).toBe(start !== end);
        expect(hoursBody(h) !== null, `${start}-${end}`).toBe(api);
        if (api) accepted++;
      }
    expect(accepted).toBe(48 * 47);
  });
  it('turning it OFF sends null (an omitted key would leave the old window in force); turning it ON sends the default window in the given zone', () => {
    expect(hoursSwitch(false, 'Europe/Madrid')).toEqual({ draft: null, patch: { working_hours: null } });
    const on = hoursSwitch(true, 'Europe/Madrid');
    expect(on.patch.working_hours).toEqual({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '22:00', end: '06:00', timezone: 'Europe/Madrid' });
    expect(workingHoursSchema.safeParse(on.patch.working_hours).success).toBe(true);
    expect(defaultHours('Asia/Tokyo').timezone).toBe('Asia/Tokyo');
  });
  it('a stored time that is not on a half hour stays in the menu so it never vanishes; the API accepts any minute', () => {
    expect(timeOptions('09:15').map((o) => o.value)).toContain('09:15');
    expect(timeOptions('09:30')).toHaveLength(48);
    expect(workingHoursSchema.safeParse({ ...ok, start: '09:15' }).success).toBe(true);
  });
  it('days are said the way a person says them', () => {
    expect(daysPhrase(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon to Fri');
    expect(daysPhrase(['sat', 'sun'])).toBe('Sat and Sun');
    expect(daysPhrase(['mon', 'wed', 'fri'])).toBe('Mon, Wed and Fri');
    expect(daysPhrase(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('every day');
    expect(hoursSummary(null)).toBe('Agents may start at any hour.');
  });
  it('toggling a day adds and removes it, and leaving none is allowed mid-edit (unconfigured is not invalid)', () => {
    const one = { ...ok, days: ['mon' as const] };
    const none = toggleDay(one, 'mon');
    expect(none.days).toEqual([]);
    expect(toggleDay(none, 'tue').days).toEqual(['tue']);
  });
  it('names the zone once, and says so when it is not the computer’s', () => {
    expect(zoneSentence('Europe/Madrid', 'Europe/Madrid')).toBe('Times are in Europe/Madrid.');
    expect(zoneSentence('America/New_York', 'Europe/Madrid')).toBe('Times are in America/New York. This computer is in Europe/Madrid.');
  });
});

describe('the reserve: Leave me X%', () => {
  it('range is the API’s own: 1 to 95 whole numbers', () => {
    for (const n of [0, 1, 50, 95, 96, 12.5, -1, NaN]) expect(validReserve(n), String(n)).toBe(reservePercentSchema.safeParse(n).success);
    for (const n of RESERVE_STEPS) expect(reservePercentSchema.safeParse(n).success, String(n)).toBe(true);
    expect(reservePercentSchema.safeParse(reserveSwitch(true)).success).toBe(true);
    expect(reserveSwitch(false)).toBeNull();
  });
  it('a stored off-step value stays in the menu', () => {
    expect(reserveOptions(17).map((o) => o.value)).toContain('17');
    expect(reserveOptions(20)).toHaveLength(RESERVE_STEPS.length);
  });
  it('not measurable (Claude Code): the API’s message is shown, a stored value is marked not kept, and it never says the person is protected', () => {
    const v = reserveView({ ...runner(), reserve_percent: 20, reserve_measurable: false, reserve_unmeasurable_message: 'API says: cannot be measured for this tool' });
    expect(v.measurable).toBe(false);
    expect(v.message).toBe('API says: cannot be measured for this tool');
    expect(v.pill).toEqual({ tone: 'warn', label: 'Not kept' });
    expect(v.summary).toContain('not kept');
    expect(v.summary).not.toMatch(/Agents pause when you have less/);
  });
  it('a field the API did not send is NOT treated as measurable, and falls back to the API’s sentence', () => {
    const v = reserveView({ ...runner(), reserve_percent: 20 });
    expect(v.measurable).toBe(false);
    expect(v.message).toBe(RESERVE_UNMEASURABLE_FALLBACK);
  });
  it('measurable: no warning, the pause is described with the tool’s subscription', () => {
    const v = reserveView({ ...runner({ chosen_tool: 'cursor', tools: [{ id: 'cursor', name: 'Cursor', installed: true }] }), reserve_percent: 30, reserve_measurable: true });
    expect(v.message).toBeNull();
    expect(v.summary).toBe('Agents pause when you have less than 30% of your Cursor limit left.');
    expect(v.pill).toEqual({ tone: 'ok', label: 'Kept' });
  });
  it('with no reserve set there is no pill, only the explanation of what it would do', () => {
    expect(reserveView({ ...runner(), reserve_measurable: false }).pill).toBeNull();
  });
});

describe('the hold line: why a Runner is not claiming now', () => {
  const at = '2026-10-29T22:00:00Z';
  it('limit_reached is amber and names the subscription and the time', () => {
    expect(describeRunner(runner({ hold: { reason: 'limit_reached', resumes_at: at }, connection: 'paused', pause_reason: 'limit_reached', paused_until: at }), NOW, TZ)).toEqual({
      tone: 'limit',
      label: 'Waiting for your Claude limit to reset at 22:00',
    });
  });
  it('working_hours is calm grey and says when it resumes; tomorrow carries the weekday', () => {
    expect(describeRunner(runner({ hold: { reason: 'working_hours', resumes_at: at } }), NOW, TZ)).toEqual({ tone: 'off', label: 'Outside working hours, resumes 22:00' });
    expect(describeRunner(runner({ hold: { reason: 'working_hours', resumes_at: '2026-10-30T22:00:00Z' } }), NOW, TZ).label).toBe('Outside working hours, resumes Fri 22:00');
  });
  it('reserve is calm grey, with a time only when the tool reported one', () => {
    expect(describeRunner(runner({ hold: { reason: 'reserve', resumes_at: null } }), NOW, TZ)).toEqual({ tone: 'off', label: 'Keeping your reserve' });
    expect(describeRunner(runner({ hold: { reason: 'reserve', resumes_at: at } }), NOW, TZ).label).toBe('Keeping your reserve, resumes 22:00');
  });
  it('only the limit is amber; no hold is gold', () => {
    for (const reason of ['working_hours', 'reserve'] as const) expect(describeHold(runner(), { reason, resumes_at: at }, NOW, TZ).tone).toBe('off');
  });
  it('a bigger fact keeps its own line: offline is not replaced by a hold, and no hold leaves the plain Online line', () => {
    expect(describeRunner(runner({ connection: 'offline', offline_since: '2026-10-29T13:00:00Z', hold: { reason: 'working_hours', resumes_at: at } }), NOW, TZ).label).toContain('Offline since');
    expect(describeRunner(runner({ hold: null }), NOW, TZ).label).toBe('Online · checked a minute ago');
  });
  it('resumeWhen: same day is the time, another day carries the weekday', () => {
    expect(resumeWhen('2026-10-29T22:00:00Z', NOW, TZ)).toBe('22:00');
    expect(resumeWhen('2026-10-31T09:00:00Z', NOW, TZ)).toBe('Sat 09:00');
  });
});

describe('the two new run states', () => {
  const wake = (state: 'waiting_for_hours' | 'waiting_for_reserve', until?: string): WakeDto => ({
    id: 'w',
    agent: { id: 'a', name: 'Agent' },
    record: null,
    reason: 'assigned',
    coalesced_count: 1,
    status: 'queued',
    run_id: null,
    run_state: { state, ...(until ? { until } : {}), runner_name: 'MacBook' },
    created_at: '2026-10-29T09:00:00Z',
    finished_at: null,
  });
  it('waiting_for_hours: calm grey, the hold words, with when it opens', () => {
    const l = describeRun(wake('waiting_for_hours', '2026-10-29T22:00:00Z'), { ...TZ, now: NOW });
    expect(l).toMatchObject({ tone: 'off', label: 'Outside working hours, resumes 22:00', action: null });
  });
  it('waiting_for_reserve: calm grey; with no reset time it promises none', () => {
    expect(describeRun(wake('waiting_for_reserve'), { ...TZ, now: NOW })).toMatchObject({ tone: 'off', label: 'Keeping your reserve' });
    expect(describeRun(wake('waiting_for_reserve', '2026-10-30T07:00:00Z'), { ...TZ, now: NOW }).label).toBe('Keeping your reserve, resumes Fri 07:00');
  });
  it('neither names the machine (a guest is not told it either way)', () => {
    for (const s of ['waiting_for_hours', 'waiting_for_reserve'] as const) expect(describeRun(wake(s), { ...TZ, now: NOW, masked: true }).label).not.toContain('MacBook');
  });
});

describe('a refusal is shown in the API’s own words', () => {
  it('the 422 for equal times reads as the API’s sentence (the page passes apiErrorMessage through), and an unknown shape falls back to a plain line', () => {
    const body = { error: { code: 'validation_failed', message: 'Request validation failed', details: [{ path: 'working_hours.end', message: 'start and end are the same time. Leave working hours off to allow every hour.' }] } };
    expect(apiErrorMessage(body, 'fallback')).toBe('start and end are the same time. Leave working hours off to allow every hour.');
    expect(apiErrorMessage(new TypeError('fetch failed'), 'Could not save that. Your earlier setting is kept.')).toBe('Could not save that. Your earlier setting is kept.');
  });
});

describe('who may edit', () => {
  it('members and admins edit their Runner; a guest, and a role that has not loaded, never do; a Runner owned by someone else refuses', () => {
    expect(canEditSharing({ role: 'member' })).toBe(true);
    expect(canEditSharing({ role: 'admin' })).toBe(true);
    expect(canEditSharing({ role: 'guest' })).toBe(false);
    expect(canEditSharing({ role: undefined })).toBe(false);
    expect(canEditSharing({ role: 'admin', meId: 'me', ownerId: 'someone-else' })).toBe(false);
    expect(canEditSharing({ role: 'member', meId: 'me', ownerId: 'me' })).toBe(true);
    for (const role of ['member', 'admin', 'guest', undefined]) expect(canEditSharing({ role }), String(role)).toBe(canUseRunners(role));
  });
});

describe('the section as markup', () => {
  const html = (r: RunnerDto, editable: boolean) => renderToStaticMarkup(createElement(SharingSection, { runner: r, editable, onSave: () => Promise.resolve(), computerZone: 'Europe/Madrid' }));
  it('Claude Code: the "cannot be measured" note is visible even with no reserve set', () => {
    const out = html(runner({ reserve_measurable: false, reserve_unmeasurable_message: RESERVE_UNMEASURABLE_FALLBACK }), true);
    expect(out).toContain('Cannot be measured for this tool.');
    expect(out).toContain(RESERVE_UNMEASURABLE_FALLBACK);
  });
  it('a tool that reports usage shows no such note', () => {
    expect(html(runner({ reserve_measurable: true }), true)).not.toContain('Cannot be measured');
  });
  it('hours off: the switch is off and says any hour; hours on: days, two time menus, the zone and the overnight hint', () => {
    const off = html(runner({ working_hours: null }), true);
    expect(off).toContain('Agents may start at any hour.');
    expect(off).not.toContain('hours-editor');
    const on = html(runner({ working_hours: { days: ['mon', 'tue'], start: '22:00', end: '06:00', timezone: 'Europe/Madrid' } }), true);
    expect(on).toContain('Agents only start Mon and Tue, 22:00 to 06:00, overnight.');
    expect(on).toContain('Times are in Europe/Madrid.');
    expect(on).toContain('Overnight: each window runs past midnight');
    expect(on).toContain('aria-label="Start time"');
    expect(on).toContain('aria-label="End time"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).not.toMatch(/<select|type="time"/);
  });
  it('someone who may not edit sees the rules in words with no switch, menu or day button, and is told why', () => {
    const out = html(runner({ working_hours: { days: ['mon'], start: '09:00', end: '17:00', timezone: 'Europe/Madrid' }, reserve_percent: 20 }), false);
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('hours-editor');
    expect(out).toContain('Only the person who owns this Runner can change these.');
    expect(out).toContain('Agents only start Mon, 09:00 to 17:00.');
  });
});
