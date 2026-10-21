import type { UserPreferences } from './preferences';

export type Regional = UserPreferences['regional'];

/** Sensible fallback when preferences haven't loaded (matches the API defaults). */
export const DEFAULT_REGIONAL: Regional = {
  dateFormat: 'system',
  timeFormat: 'system',
  firstDayOfWeek: 'system',
};

// A locale whose default numeric date order matches each choice.
const DATE_LOCALE: Record<Exclude<Regional['dateFormat'], 'system'>, string> = {
  MDY: 'en-US', // 07/14/2026
  DMY: 'en-GB', // 14/07/2026
  YMD: 'sv-SE', // 2026-07-14
};

/** A date with no time: `2026-10-21`, or the midnight-UTC ISO a date field stores. It names a CALENDAR DAY, not an instant. */
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z?)?$/;

/**
 * A value as a Date. A day-only string becomes local midnight of THAT calendar day: `new Date('2026-10-21')` is UTC
 * midnight, which west of UTC is still the 20th on the clock — a date a person typed would display as the day before.
 */
function toDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = DAY_ONLY.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole calendar days from `now` to `d` (tomorrow = 1), DST-safe because both sides are local midnights. */
function dayOffset(d: Date, now: Date): number {
  return Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
}

export interface FormatOptions {
  /** The moment "today" is measured from. Tests pass one; callers never need to. */
  now?: Date;
  /** Say Today / Tomorrow / Yesterday for near dates (default). A preview of the format itself turns it off. */
  relative?: boolean;
}

/**
 * #1005 — the friendly form: Today / Tomorrow / Yesterday, then "21 Oct" this year and "21 Oct 2025" any other year.
 * Month names and their order come from the viewer's own locale (en-GB "21 Oct", en-US "Oct 21") — nothing here
 * hard-codes a locale. Used only for the `system` setting; a person who picked MM/DD/YYYY, DD/MM/YYYY or YYYY-MM-DD
 * asked for numerals and gets them.
 */
function friendlyDate(d: Date, now: Date, relative: boolean): string {
  if (relative) {
    const off = dayOffset(d, now);
    if (off === 0) return 'Today';
    if (off === 1) return 'Tomorrow';
    if (off === -1) return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function datePart(d: Date, r: Regional, o: FormatOptions = {}): string {
  if (r.dateFormat === 'system') return friendlyDate(d, o.now ?? new Date(), o.relative !== false);
  return d.toLocaleDateString(DATE_LOCALE[r.dateFormat], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function timePart(d: Date, r: Regional): string {
  const hour12 = r.timeFormat === 'system' ? undefined : r.timeFormat === '12h';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(hour12 !== undefined ? { hour12 } : {}),
  });
}

/** Date only, honoring the user's date-format preference. */
export function formatDate(value: unknown, r: Regional = DEFAULT_REGIONAL, o: FormatOptions = {}): string {
  const d = toDate(value);
  return d ? datePart(d, r, o) : '';
}

/** Date + time, honoring date-format + 12/24h preferences. */
export function formatDateTime(value: unknown, r: Regional = DEFAULT_REGIONAL, o: FormatOptions = {}): string {
  const d = toDate(value);
  return d ? `${datePart(d, r, o)}, ${timePart(d, r)}` : '';
}

/** Sunday=0 … Saturday=6, resolving 'system' to the locale's first day. */
export function firstWeekday(r: Regional = DEFAULT_REGIONAL): number {
  if (r.firstDayOfWeek === 'sunday') return 0;
  if (r.firstDayOfWeek === 'monday') return 1;
  if (r.firstDayOfWeek === 'saturday') return 6;
  // 'system': most locales start Monday; en-US/en-CA start Sunday.
  return /^en-(US|CA)\b/i.test(typeof navigator !== 'undefined' ? navigator.language : 'en-US') ? 0 : 1;
}
