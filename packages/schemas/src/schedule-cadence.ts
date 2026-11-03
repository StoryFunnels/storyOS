/**
 * Ticket #1194 — the schedule trigger's cadence: validation AND next-due arithmetic in ONE place, so the REST schema, the service
 * (which packs and manifests go through), and the MCP builder cannot disagree about what a schedule is.
 *
 * Shape: { every: 'minutes'|'hour'|'day'|'week', minutes?, at?, weekday?, weekdays?, between?, timezone? }.
 *
 * A "session" is one local date D's run of slots: start..end, slots at start + k*N minutes of ELAPSED time (so a DST day never gaps or
 * duplicates a slot). No window: D 00:00 to the next 00:00. With `between` {from,to}: D at `from` to D at `to` (the next day when
 * from > to, i.e. the window spans midnight), `to` EXCLUSIVE. The weekday set is checked on D, so a window that spans midnight
 * belongs to the day it STARTS. day/week modes are one slot at `at`.
 *
 * ZOD-FREE on purpose: the MCP bundle imports this module (`@storyos/schemas/schedule-cadence`), and a zod import in it crashes the
 * bundled image at boot ("Dynamic require of zod"). The zod schema lives in schedule.ts and calls scheduleProblems from here.
 */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 10;
export const SCHEDULE_MAX_INTERVAL_MINUTES = 1440;

export interface ScheduleTrigger {
  type: 'schedule';
  every: 'minutes' | 'hour' | 'day' | 'week';
  minutes?: number;
  at?: string;
  weekday?: number;
  weekdays?: number[];
  between?: { from: string; to: string };
  timezone?: string;
}

/** Every reason a schedule trigger is not valid, as plain sentences; empty = valid. The single source of the 422 text. */
export function scheduleProblems(t: Partial<ScheduleTrigger> & { every?: string }): string[] {
  const out: string[] = [];
  if (t.every === 'minutes') {
    if (t.minutes === undefined) out.push('"every: minutes" needs "minutes" (how many minutes between runs, at least 10).');
    else if (!Number.isInteger(t.minutes) || t.minutes < SCHEDULE_MIN_INTERVAL_MINUTES) {
      out.push(
        `A schedule can run at most every ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes: "minutes" must be a whole number of at least ${SCHEDULE_MIN_INTERVAL_MINUTES} (got ${String(t.minutes)}).`,
      );
    } else if (t.minutes > SCHEDULE_MAX_INTERVAL_MINUTES) {
      out.push(`"minutes" can be at most ${SCHEDULE_MAX_INTERVAL_MINUTES} (a day); use every: "day" for a daily run.`);
    }
  } else if (t.minutes !== undefined) {
    out.push('"minutes" only applies to every: "minutes".');
  }
  if (t.weekdays !== undefined) {
    if (t.every === 'week') out.push('"weekdays" does not apply to every: "week"; a weekly rule uses the single "weekday".');
    if (new Set(t.weekdays).size !== t.weekdays.length) out.push('"weekdays" lists a day twice.');
  }
  if (t.between !== undefined) {
    if (t.every !== 'minutes' && t.every !== 'hour') out.push('"between" (an active window) only applies to every: "minutes" or "hour".');
    else if (t.between.from === t.between.to) out.push('"between" needs different from and to times (from 09:00 to 09:00 is empty or the whole day).');
  }
  if (t.timezone !== undefined && !isValidTimeZone(t.timezone)) out.push(`"timezone" must be an IANA time zone such as "Europe/Madrid" (got "${t.timezone}").`);
  return out;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
function parts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}
/** UTC offset (ms) of `tz` at the instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0) - Math.floor(ms / 60000) * 60000;
}
/**
 * The instant at which `tz`'s wall clock reads y-mo-d h:mi. A time that does not exist (spring-forward gap) lands just after the gap;
 * a time that occurs twice (fall-back) is the FIRST occurrence.
 */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offs = new Set([offsetAt(guess - 86_400_000, tz), offsetAt(guess + 86_400_000, tz)]);
  const valid: number[] = [];
  for (const o of offs) if (offsetAt(guess - o, tz) === o) valid.push(guess - o);
  if (valid.length > 0) return Math.min(...valid);
  return guess - offsetAt(guess - 86_400_000, tz); // in a gap: the pre-transition offset puts it just after the gap
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const isNew = (t: ScheduleTrigger) => t.every === 'minutes' || t.weekdays !== undefined || t.between !== undefined || t.timezone !== undefined;
/** A rule with none of the #1194 keys keeps the original server-local arithmetic exactly (see legacyNextDue). */
export function isLegacySchedule(t: ScheduleTrigger): boolean {
  return !isNew(t);
}

/** The original (pre-#1194) next-due, in the server's own zone. Kept verbatim so stored rules do not move. */
function legacyNextDue(trigger: ScheduleTrigger, from: Date): Date {
  const due = new Date(from);
  if (trigger.every === 'hour') {
    due.setMinutes(0, 0, 0);
    due.setHours(due.getHours() + 1);
    return due;
  }
  const [h, m] = (trigger.at ?? '09:00').split(':').map(Number);
  due.setHours(h!, m!, 0, 0);
  if (trigger.every === 'day') {
    if (due <= from) due.setDate(due.getDate() + 1);
    return due;
  }
  const targetDay = trigger.weekday ?? 1;
  while (due.getDay() !== targetDay || due <= from) due.setDate(due.getDate() + 1);
  return due;
}

/** Slots of the session that starts on local date (y,mo,d), as epoch ms, ascending. */
function sessionSlots(t: ScheduleTrigger, tz: string, y: number, mo: number, d: number): number[] {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (t.every === 'week') {
    if (dow !== (t.weekday ?? 1)) return [];
  } else if (t.weekdays && !t.weekdays.includes(dow)) return [];
  if (t.every === 'day' || t.every === 'week') {
    const at = t.at ?? '09:00';
    return [wallToUtc(y, mo, d, Number(at.slice(0, 2)), Number(at.slice(3, 5)), tz)];
  }
  const step = (t.every === 'hour' ? 60 : (t.minutes ?? 60)) * 60_000;
  let startMin = 0;
  let endDayOffset = 1;
  let endMin = 0;
  if (t.between) {
    startMin = toMin(t.between.from);
    endMin = toMin(t.between.to);
    endDayOffset = endMin > startMin ? 0 : 1;
  }
  const start = wallToUtc(y, mo, d, Math.floor(startMin / 60), startMin % 60, tz);
  const next = new Date(Date.UTC(y, mo - 1, d + endDayOffset));
  const end = wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), Math.floor(endMin / 60), endMin % 60, tz);
  const out: number[] = [];
  for (let s = start; s < end; s += step) out.push(s);
  return out;
}

/** Local dates (as y/mo/d) from `back` days before to `fwd` days after the date `ms` falls on in `tz`. */
function* localDates(ms: number, tz: string, back: number, fwd: number) {
  const p = parts(ms, tz);
  for (let i = -back; i <= fwd; i++) {
    const x = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    yield { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() };
  }
}

/** The first slot strictly after `from`. */
export function nextScheduleSlot(trigger: ScheduleTrigger, from: Date, fallbackZone = serverTimeZone()): Date {
  if (isLegacySchedule(trigger)) return legacyNextDue(trigger, from);
  const tz = trigger.timezone ?? fallbackZone;
  // a weekly rule can be 7 days out; a window that spans midnight starts the day before
  for (const { y, mo, d } of localDates(from.getTime(), tz, 1, 9)) {
    for (const s of sessionSlots(trigger, tz, y, mo, d)) if (s > from.getTime()) return new Date(s);
  }
  return legacyNextDue({ ...trigger, every: trigger.every === 'minutes' ? 'hour' : trigger.every }, from); // unreachable for a valid trigger
}

/** The latest slot at or before `at`, or null when none in the last 10 days (a missed-slot scan, never unbounded). */
export function latestScheduleSlot(trigger: ScheduleTrigger, at: Date, fallbackZone = serverTimeZone()): Date | null {
  if (isLegacySchedule(trigger)) return null;
  const tz = trigger.timezone ?? fallbackZone;
  let best: number | null = null;
  for (const { y, mo, d } of localDates(at.getTime(), tz, 9, 1)) {
    for (const s of sessionSlots(trigger, tz, y, mo, d)) if (s <= at.getTime() && (best === null || s > best)) best = s;
  }
  return best === null ? null : new Date(best);
}

/** Is `at` inside the rule's active window and weekday set? Always true for a rule with no window. */
export function isInScheduleWindow(trigger: ScheduleTrigger, at: Date, fallbackZone = serverTimeZone()): boolean {
  if (!trigger.between) return true;
  const tz = trigger.timezone ?? fallbackZone;
  const ms = at.getTime();
  for (const { y, mo, d } of localDates(ms, tz, 1, 0)) {
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (trigger.weekdays && !trigger.weekdays.includes(dow)) continue;
    const from = toMin(trigger.between.from);
    const to = toMin(trigger.between.to);
    const start = wallToUtc(y, mo, d, Math.floor(from / 60), from % 60, tz);
    const n = new Date(Date.UTC(y, mo - 1, d + (to > from ? 0 : 1)));
    const end = wallToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), Math.floor(to / 60), to % 60, tz);
    if (ms >= start && ms < end) return true;
  }
  return false;
}

/** Runs on a typical qualifying day, for "about 54 runs a day". Null for a weekly rule (it is not a per-day figure). */
export function scheduleRunsPerDay(trigger: ScheduleTrigger, fallbackZone = serverTimeZone()): number | null {
  if (trigger.every === 'week') return null;
  if (trigger.every === 'day') return 1;
  const tz = trigger.timezone ?? fallbackZone;
  // a mid-January and a mid-July day bracket any DST; take the larger, and a day with no weekday restriction
  const free: ScheduleTrigger = { ...trigger, weekdays: undefined };
  return Math.max(sessionSlots(free, tz, 2027, 1, 13).length, sessionSlots(free, tz, 2027, 7, 14).length);
}
