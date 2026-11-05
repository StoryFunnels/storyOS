import { canUseRunners } from './access';
import type { RunnerDto, RunnerSharingPatch, WorkingDay, WorkingHours } from './types';
import { limitBrand, toolName } from './words';

/**
 * Ticket #1137 — "Sharing your subscription": the person's own rules for when their agents may use their Claude or Cursor time.
 * Pure functions of the API's shapes (`runner-sharing.ts`, `runner-present.ts`), so each rule has a test that fails when it breaks.
 *
 * Two rules, both per RUNNER (a Runner is one computer and one subscription; hours are not per agent):
 *  - WORKING HOURS: the window in which agents may START. Outside it nothing is claimed (a run already going finishes). Days, a start
 *    and an end in an IANA zone. An end that is not after the start is an overnight window that belongs to the day it starts.
 *  - LEAVE ME X%: agents pause when less than X% of the person's plan is left, ONLY where the tool reports plan usage. Claude Code's
 *    command line does not, so the value is stored but cannot be kept, and the screen must never imply it is.
 *
 * "Unconfigured is not invalid": a draft with no day chosen is a state the person is passing through, so it is kept on screen and
 * simply not sent; only a draft the API would accept becomes a request.
 */

export const DAYS: ReadonlyArray<{ key: WorkingDay; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];
const DAY_KEYS: readonly WorkingDay[] = DAYS.map((d) => d.key);

/** 00:00 … 23:30 in 30-minute steps: what the time menus offer. A native time input is not used in this product. */
export const TIME_STEPS: readonly string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

/** The API's own bounds for "Leave me X%": whole numbers 1 to 95 (`reservePercentSchema`, runner-sharing.ts). */
export const RESERVE_MIN = 1;
export const RESERVE_MAX = 95;
export const RESERVE_DEFAULT = 20;
/** The steps the menu offers; a stored value that is not one of them is still shown (see `reserveOptions`). */
export const RESERVE_STEPS: readonly number[] = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 95];

/** The sentence the API sends for a tool whose usage is not reported (`RESERVE_UNMEASURABLE_MESSAGE`); used only if the field is absent. */
export const RESERVE_UNMEASURABLE_FALLBACK =
  'This tool does not report how much of your plan is used, so StoryOS cannot keep a share back for you. Working hours and the pause when the tool hits its limit still apply.';

/**
 * Who may change a Runner's sharing rules. A Runner is one person's computer and subscription (ADR-0021 §3) and `GET .../runners`
 * returns only the CALLER's own, so every row on Settings › Runners is the viewer's. This is still a named predicate rather than an
 * assumption: members and admins edit THEIR Runners, a guest never holds one, and a role that has not loaded is "not yet".
 * `ownerId` is passed when a surface knows it (a Runner that names its owner); an explicit mismatch refuses.
 */
export function canEditSharing(o: { role: string | undefined; meId?: string | null; ownerId?: string | null }): boolean {
  if (!canUseRunners(o.role)) return false;
  if (o.ownerId && o.meId && o.ownerId !== o.meId) return false;
  return true;
}

/** The viewer's own zone: the browser's. There is no time-zone preference to read. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** What is on screen while editing; the same shape as the API's, with the days in the order the person clicked. */
export interface HoursDraft {
  days: WorkingDay[];
  start: string;
  end: string;
  timezone: string;
}

/**
 * Switching working hours ON starts from "every night, 22:00 to 06:00": the ticket's own example is agents working mostly
 * overnight, and it is a window the API accepts, so turning the switch on is itself a valid save.
 */
export function defaultHours(timezone: string): HoursDraft {
  return { days: [...DAY_KEYS], start: '22:00', end: '06:00', timezone };
}

/**
 * The working-hours switch. ON saves the default window (valid, so the switch itself is a save); OFF saves `null`, which is how
 * the API clears the rule ("a save that clears hours sends null": omitting the key would leave the old window in force).
 */
export function hoursSwitch(on: boolean, timezone: string): { draft: HoursDraft | null; patch: RunnerSharingPatch } {
  if (!on) return { draft: null, patch: { working_hours: null } };
  const draft = defaultHours(timezone);
  return { draft, patch: { working_hours: hoursBody(draft) } };
}

/** The reserve switch: ON keeps the default share, OFF is `null` (no reserve). */
export function reserveSwitch(on: boolean): number | null {
  return on ? RESERVE_DEFAULT : null;
}

export function isOvernight(h: Pick<HoursDraft, 'start' | 'end'>): boolean {
  return h.end <= h.start;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The sentence for a draft the API would refuse, or null. Mirrors `workingHoursSchema` (runner-sharing.ts): at least one day, valid
 * 24-hour times, and start is not end. A draft with a problem is kept on screen and not sent.
 */
export function hoursProblem(h: HoursDraft): string | null {
  if (h.days.length === 0) return 'Choose at least one day, or switch working hours off.';
  if (!HHMM.test(h.start) || !HHMM.test(h.end)) return 'Choose a start and an end time.';
  if (h.start === h.end) return 'Start and end are the same time. Choose different times, or switch working hours off to allow every hour.';
  return null;
}

/** The API body for a draft, or null while it has a problem (nothing is sent). Days are sent in week order, as the API stores them. */
export function hoursBody(h: HoursDraft): WorkingHours | null {
  if (hoursProblem(h)) return null;
  return { days: DAY_KEYS.filter((d) => h.days.includes(d)), start: h.start, end: h.end, timezone: h.timezone };
}

/** The draft the screen edits for what the server holds: a copy, so editing never mutates the cached Runner. */
export function draftFromServer(h: WorkingHours): HoursDraft {
  return { days: [...h.days], start: h.start, end: h.end, timezone: h.timezone };
}

export function toggleDay(h: HoursDraft, day: WorkingDay): HoursDraft {
  return { ...h, days: h.days.includes(day) ? h.days.filter((d) => d !== day) : [...h.days, day] };
}

/** "every day", "Mon to Fri", "Sat and Sun", "Mon, Wed and Fri": the days as a person would say them. */
export function daysPhrase(days: readonly WorkingDay[]): string {
  const idx = DAY_KEYS.map((k, i) => (days.includes(k) ? i : -1)).filter((i) => i >= 0);
  const label = (i: number) => DAYS[i]!.label;
  if (idx.length === 7) return 'every day';
  if (idx.length === 0) return 'no day';
  if (idx.length === 1) return label(idx[0]!);
  const run = idx.every((v, k) => k === 0 || v === idx[k - 1]! + 1);
  if (run && idx.length >= 3) return `${label(idx[0]!)} to ${label(idx[idx.length - 1]!)}`;
  if (idx.length === 2) return `${label(idx[0]!)} and ${label(idx[1]!)}`;
  return `${idx.slice(0, -1).map(label).join(', ')} and ${label(idx[idx.length - 1]!)}`;
}

/** "Mon to Fri, 22:00 to 06:00, overnight". An overnight window says so, and that it belongs to the day it starts. */
export function windowPhrase(h: HoursDraft): string {
  return `${daysPhrase(h.days)}, ${h.start} to ${h.end}${isOvernight(h) ? ', overnight' : ''}`;
}

/** The line under the switch. */
export function hoursSummary(h: WorkingHours | null): string {
  return h ? `Agents only start ${windowPhrase(h)}.` : 'Agents may start at any hour.';
}

/** "Times are in Europe/Madrid." The zone is named once, here; if it is not the computer's own, that is said too. */
export function zoneSentence(timezone: string, computerZone: string): string {
  const base = `Times are in ${timezone.replace(/_/g, ' ')}.`;
  return timezone === computerZone ? base : `${base} This computer is in ${computerZone.replace(/_/g, ' ')}.`;
}

/** The hint under the times: only an overnight window needs one. */
export function overnightHint(h: Pick<HoursDraft, 'start' | 'end'>): string | null {
  // Equal times are the refused case (no window at all), so they get the problem sentence and never the overnight hint.
  return h.end < h.start ? 'Overnight: each window runs past midnight and belongs to the day it starts.' : null;
}

/** The time menu's values: the 30-minute steps, plus a stored time that is not one of them (the API accepts any minute) so it never vanishes. */
export function timeOptions(current: string): Array<{ value: string; label: string }> {
  const all = TIME_STEPS.includes(current) || !HHMM.test(current) ? [...TIME_STEPS] : [...TIME_STEPS, current].sort();
  return all.map((v) => ({ value: v, label: v }));
}

export function reserveOptions(current: number | null): Array<{ value: string; label: string }> {
  const all = current !== null && !RESERVE_STEPS.includes(current) ? [...RESERVE_STEPS, current].sort((a, b) => a - b) : [...RESERVE_STEPS];
  return all.map((n) => ({ value: String(n), label: `${n}%` }));
}

/** The API's rule for a reserve (`reservePercentSchema`): a whole number, 1 to 95. */
export function validReserve(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= RESERVE_MIN && n <= RESERVE_MAX;
}

export interface ReserveView {
  percent: number | null;
  /** True only where the tool reports plan usage. Anything else (false, or a field the API did not send) is NOT enforced. */
  measurable: boolean;
  /** The note to show prominently when the reserve cannot be kept; null when it can. */
  message: string | null;
  /** The line under the switch. */
  summary: string;
  /** The pill: what the stored value is actually doing. */
  pill: { tone: 'ok' | 'warn' | 'neutral'; label: string } | null;
}

/**
 * What "Leave me X%" is really doing for this Runner. Never says the person is protected unless the tool reports plan usage: for
 * Claude Code it cannot, and a reserve that looks kept while it is not would spend the person's own time while telling them it
 * would not.
 */
export function reserveView(r: Pick<RunnerDto, 'reserve_percent' | 'reserve_measurable' | 'reserve_unmeasurable_message' | 'chosen_tool' | 'tools'>): ReserveView {
  const percent = r.reserve_percent ?? null;
  const measurable = r.reserve_measurable === true;
  const brand = limitBrand(r.chosen_tool, r.tools);
  const message = measurable ? null : (r.reserve_unmeasurable_message ?? RESERVE_UNMEASURABLE_FALLBACK);
  if (percent === null) {
    return { percent, measurable, message, summary: `Agents pause when your share of the ${brand} limit runs low.`, pill: null };
  }
  const tool = toolName(r.chosen_tool, r.tools);
  return measurable
    ? { percent, measurable, message, summary: `Agents pause when you have less than ${percent}% of your ${brand} limit left.`, pill: { tone: 'ok', label: 'Kept' } }
    : {
        percent,
        measurable,
        message,
        summary: `Saved at ${percent}%, but ${tool} does not report your usage, so it is not kept.`,
        pill: { tone: 'warn', label: 'Not kept' },
      };
}

export type { RunnerSharingPatch };
