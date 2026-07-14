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

function toDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function datePart(d: Date, r: Regional): string {
  if (r.dateFormat === 'system') return d.toLocaleDateString();
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
export function formatDate(value: unknown, r: Regional = DEFAULT_REGIONAL): string {
  const d = toDate(value);
  return d ? datePart(d, r) : '';
}

/** Date + time, honoring date-format + 12/24h preferences. */
export function formatDateTime(value: unknown, r: Regional = DEFAULT_REGIONAL): string {
  const d = toDate(value);
  return d ? `${datePart(d, r)}, ${timePart(d, r)}` : '';
}

/** Sunday=0 … Saturday=6, resolving 'system' to the locale's first day. */
export function firstWeekday(r: Regional = DEFAULT_REGIONAL): number {
  if (r.firstDayOfWeek === 'sunday') return 0;
  if (r.firstDayOfWeek === 'monday') return 1;
  if (r.firstDayOfWeek === 'saturday') return 6;
  // 'system': most locales start Monday; en-US/en-CA start Sunday.
  return /^en-(US|CA)\b/i.test(typeof navigator !== 'undefined' ? navigator.language : 'en-US') ? 0 : 1;
}
