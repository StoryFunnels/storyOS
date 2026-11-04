import { z } from 'zod';

/**
 * ticket #1137 / ADR-0021 §5, §11: how a person SHARES their subscription with their agents. Three independent reasons a Runner may
 * not claim right now, ONE function that answers "may it, and until when" (`holdFor`), read by the claim, the Runner's own summary
 * and the run state, so the three never disagree:
 *
 *  - `limit_reached`  the tool hit its subscription limit (ticket #1133 wrote `paused_until`); resumes at that time.
 *  - `working_hours`  outside the person's chosen window (a day set, a time window, an IANA time zone); resumes when it opens.
 *  - `reserve`        the tool REPORTED that the person's own remaining share fell below "leave me X%". Only where the tool reports it.
 *
 * Pure: nothing here reads the clock or the database. `now` is always passed in, which is what lets a test drive time.
 */

export const WORKING_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WorkingDay = (typeof WORKING_DAYS)[number];

export interface WorkingHours {
  days: string[];
  /** Local wall-clock "HH:MM" in `timezone`. When `end` is not after `start` the window runs past midnight (overnight agents). */
  start: string;
  end: string;
  /** IANA name ("Europe/Kyiv"). The window is wall-clock time in this zone, so it follows daylight saving, not a fixed UTC offset. */
  timezone: string;
}

/** Stored in `runners.sharing`. A missing key means "no rule". */
export interface RunnerSharing {
  working_hours?: WorkingHours | null;
  /** "Leave me X%": 1..95. null / absent = no reserve. */
  reserve_percent?: number | null;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 22:00');
const zone = z.string().trim().min(1).max(64).refine(isValidTimeZone, { message: 'Not a known time zone. Use an IANA name like Europe/Kyiv.' });

export const workingHoursSchema = z
  .object({
    days: z.array(z.enum(WORKING_DAYS)).min(1).max(7),
    start: hhmm,
    end: hhmm,
    timezone: zone,
  })
  .refine((v) => v.start !== v.end, { message: 'start and end are the same time. Leave working hours off to allow every hour.', path: ['end'] })
  .transform((v) => ({ ...v, days: WORKING_DAYS.filter((d) => v.days.includes(d)) }));

export const reservePercentSchema = z.number().int().min(1).max(95);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ time zones

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour! % 24, mi: out.minute!, s: out.second! };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `tz` reads y-mo-d h:mi. Two passes settle the offset across a daylight-saving change. A
 * wall time that does not exist (the spring-forward gap) lands just after the gap; one that happens twice (autumn) is its FIRST
 * occurrence. Both are the conventional readings and neither can make a window open or close an hour away from the clock on the wall.
 */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  const back = localParts(guess, tz);
  if (back.h !== h || back.mi !== mi) {
    // Inside a gap: the instant after it.
    const other = wall - offsetMs(guess - 3_600_000, tz);
    return Math.max(guess, other);
  }
  return guess;
}

const DAY_OF_WEEK: WorkingDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const minutes = (hm: string): [number, number] => [Number(hm.slice(0, 2)), Number(hm.slice(3, 5))];

export type HoursState = { open: true; closes_at: Date } | { open: false; resumes_at: Date };

/**
 * Is `now` inside the working window, and when does that next change? A window belongs to the day it STARTS on, so Monday 22:00 to
 * 06:00 is Monday night into Tuesday morning, and at 02:00 on Tuesday the Runner is inside Monday's window.
 */
export function hoursState(h: WorkingHours, now: Date): HoursState {
  const t = now.getTime();
  const today = localParts(t, h.timezone);
  const [sh, sm] = minutes(h.start);
  const [eh, em] = minutes(h.end);
  const overnight = h.end <= h.start;
  let next: number | null = null;
  // Yesterday (an overnight window may still be open), today, and a week ahead.
  for (let offset = -1; offset <= 8; offset++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + offset));
    if (!h.days.includes(DAY_OF_WEEK[day.getUTCDay()]!)) continue;
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const start = zonedToUtc(y, mo, d, sh, sm, h.timezone);
    const endDay = new Date(Date.UTC(y, mo - 1, d + (overnight ? 1 : 0)));
    const end = zonedToUtc(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), eh, em, h.timezone);
    if (t >= start && t < end) {
      // Back-to-back windows (Mon 22-06 then Tue 06-... ) are not merged: the close is reported as it is. Callers only compare to now.
      return { open: true, closes_at: new Date(end) };
    }
    if (start > t && (next === null || start < next)) next = start;
  }
  // Seven days of nothing is impossible for a non-empty day set; fall back far enough that the Runner keeps asking.
  return { open: false, resumes_at: new Date(next ?? t + 7 * 86_400_000) };
}

// ------------------------------------------------------------------------------------------------ the reserve

export interface ToolLike {
  id: string;
  installed?: boolean;
  capabilities?: Record<string, unknown>;
}

/** What a tool says about the person's plan-level usage, when it says anything. Never inferred, never defaulted to zero. */
export function planUsage(tool: ToolLike | undefined): { percent_used: number; resets_at: Date | null } | null {
  const raw = tool?.capabilities?.plan_usage_percent;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  const at = typeof tool?.capabilities?.plan_usage_resets_at === 'string' ? new Date(tool.capabilities.plan_usage_resets_at as string) : null;
  return { percent_used: Math.min(raw, 100), resets_at: at && Number.isFinite(at.getTime()) ? at : null };
}

/**
 * Can "leave me X%" be honoured for this tool? Only if the tool REPORTS the plan-level usage. The Claude Code CLI (2.1.104) reports
 * per-run token usage in its result and nothing about the plan's quota, so for it this is false and the Runners page says so: a
 * reserve that cannot be measured must never look like one that is being kept.
 */
export function reserveMeasurable(tool: ToolLike | undefined): boolean {
  return planUsage(tool) !== null;
}

export const RESERVE_UNMEASURABLE_MESSAGE =
  'This tool does not report how much of your plan is used, so StoryOS cannot keep a share back for you. Working hours and the pause when the tool hits its limit still apply.';

// ------------------------------------------------------------------------------------------------ the one answer

export type HoldReason = 'limit_reached' | 'working_hours' | 'reserve';
export interface Hold {
  reason: HoldReason;
  /** When it can claim again, or null when that is not known (a reserve with no reset time reported). */
  resumes_at: Date | null;
}

export interface SharingRunner {
  pausedUntil: Date | null;
  sharing?: RunnerSharing | null;
  chosenTool: string | null;
  tools: ToolLike[];
}

/** Every reason this Runner may not claim at `now`, in a fixed order. Empty = it may. */
export function holdsFor(r: SharingRunner, now: Date): Hold[] {
  const out: Hold[] = [];
  if (r.pausedUntil && r.pausedUntil.getTime() > now.getTime()) out.push({ reason: 'limit_reached', resumes_at: r.pausedUntil });
  const wh = r.sharing?.working_hours;
  if (wh) {
    const s = hoursState(wh, now);
    if (!s.open) out.push({ reason: 'working_hours', resumes_at: s.resumes_at });
  }
  const reserve = r.sharing?.reserve_percent;
  if (reserve) {
    const usage = planUsage(r.tools.find((t) => t.id === r.chosenTool));
    if (usage && usage.percent_used > 100 - reserve) {
      const resets = usage.resets_at && usage.resets_at.getTime() > now.getTime() ? usage.resets_at : null;
      out.push({ reason: 'reserve', resumes_at: resets });
    }
  }
  return out;
}

/**
 * The ONE hold to show and to sleep for. When two apply the Runner must wait for BOTH to lift, so the answer is the latest known
 * resume time; a hold with no known time (reserve) wins outright because nothing can say when it ends.
 */
export function holdFor(r: SharingRunner, now: Date): Hold | null {
  const holds = holdsFor(r, now);
  if (holds.length === 0) return null;
  const unknown = holds.find((h) => h.resumes_at === null);
  if (unknown) return unknown;
  return holds.reduce((a, b) => (b.resumes_at!.getTime() > a.resumes_at!.getTime() ? b : a));
}
