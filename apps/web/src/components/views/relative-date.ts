import { sampleDate } from '@storyos/schemas';

/**
 * ticket #1155 — a date filter's RELATIVE operand, as words and back.
 *
 * The API reads `before` / `after` values of the form `$date:-90d` / `$date:+3d` (ticket #1147, PR #1335): N whole DAYS before or after
 * today (UTC), resolved at query time. This module is the web's one reading of that token: authoring builds it, every summary of a date
 * condition formats it, and nothing else in the web touches the string. It is deliberately NOT a fourth dialect — the token is the API's,
 * `sampleDate` (the API's own builder) writes it, and `relative-date.unit.test.ts` pins `parseRelativeDate` against
 * `resolveSampleDate` (the API's reader) so the two cannot drift.
 *
 * Only DAYS exist in the token, so only days and weeks (a multiple of seven days) are offered: a "month" is not a fixed number of days,
 * and a filter that says "3 months ago" while meaning 90 days would be the silent kind of wrong. Months need an API token first.
 *
 * Anything that is not exactly the token (an absolute date, an empty string, `$date:-ninety`, a non-string) parses to null, so callers
 * fall back to showing the raw value and never throw.
 */

export type RelativeDateUnit = 'days' | 'weeks';
export type RelativeDateDirection = 'ago' | 'ahead';
export interface RelativeDate {
  amount: number;
  unit: RelativeDateUnit;
  direction: RelativeDateDirection;
}

/** The API's own ceiling (`\d{1,4}` in `resolveSampleDate`). */
export const MAX_RELATIVE_DAYS = 9999;
const TOKEN = /^\$date:([+-])(\d{1,4})d$/;

/**
 * Reads a stored value. A whole number of weeks (7, 14, …) reads as weeks, so authoring "2 weeks" and reopening it says "2 weeks";
 * every other count reads as days. `$date:+0d` / `$date:-0d` read as zero days (formatted "today").
 */
export function parseRelativeDate(value: unknown): RelativeDate | null {
  if (typeof value !== 'string') return null;
  const m = TOKEN.exec(value);
  if (!m) return null;
  const days = Number(m[2]);
  const direction: RelativeDateDirection = m[1] === '-' ? 'ago' : 'ahead';
  if (days >= 7 && days % 7 === 0) return { amount: days / 7, unit: 'weeks', direction };
  return { amount: days, unit: 'days', direction };
}

/** The token for an authored (amount, unit, direction), or null when the amount is not a whole number the API accepts (1..9999 days). */
export function buildRelativeDate(amount: number, unit: RelativeDateUnit, direction: RelativeDateDirection): string | null {
  if (!Number.isInteger(amount) || amount < 1) return null;
  const days = unit === 'weeks' ? amount * 7 : amount;
  if (days > MAX_RELATIVE_DAYS) return null;
  return sampleDate(direction === 'ago' ? -days : days);
}

/** The largest amount of a unit the API's token can hold: 9999 days, or 1428 weeks (1428 x 7 = 9996; 1429 weeks would be 10003 days). */
export function maxAmountFor(unit: RelativeDateUnit): number {
  return unit === 'weeks' ? Math.floor(MAX_RELATIVE_DAYS / 7) : MAX_RELATIVE_DAYS;
}

/**
 * What is wrong with a typed amount, or null when it builds a token. `blank` and `zero` are the unfinished states; `too-large` is
 * a number the API's 4-digit day limit cannot hold, so it is flagged (never silently clamped to a different filter than the one typed).
 * Re-run on every unit switch: 5000 is fine as days and too large as weeks.
 */
export function amountProblem(amount: string, unit: RelativeDateUnit): 'blank' | 'zero' | 'too-large' | null {
  const t = amount.trim();
  if (t === '') return 'blank';
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return 'blank';
  if (n === 0) return 'zero';
  return n > maxAmountFor(unit) ? 'too-large' : null;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "90 days ago", "3 days from now", "2 weeks ago", "today". Null when the value is not a relative date. */
export function formatRelativeDate(value: unknown): string | null {
  const r = parseRelativeDate(value);
  if (!r) return null;
  if (r.amount === 0) return 'today';
  const span = plural(r.amount, r.unit === 'weeks' ? 'week' : 'day');
  return r.direction === 'ago' ? `${span} ago` : `${span} from now`;
}

/**
 * A whole date condition in words, for the summaries (pinned chip, condition label). Null unless `op` is `before`/`after` and `value` is a
 * relative date — the only place the API accepts one — so an absolute date, or a token on any other op, keeps its ordinary text.
 *
 * The wording is exact, not the nearest friendly phrase: `before $date:-90d` is "more than 90 days ago" (older than that day, so it
 * excludes day 90 itself); `after $date:+3d` is "more than 3 days from now". The other two pairings have no shorter true phrase, so
 * they keep the operator: "before 3 days from now" (which includes everything in the past) and "after 90 days ago".
 */
export function describeRelativeDateCondition(op: string, value: unknown): string | null {
  if (op !== 'before' && op !== 'after') return null;
  const r = parseRelativeDate(value);
  const when = formatRelativeDate(value);
  if (!r || !when) return null;
  if (r.amount === 0) return `${op} ${when}`;
  if (op === 'before' && r.direction === 'ago') return `more than ${when}`;
  if (op === 'after' && r.direction === 'ahead') return `more than ${when}`;
  return `${op} ${when}`;
}

/** The authoring menu: one select picks both unit and direction (plus the exact-date escape hatch). */
export type RelativeDateKind = 'date' | 'days-ago' | 'weeks-ago' | 'days-ahead' | 'weeks-ahead';
export const RELATIVE_DATE_KINDS: Array<{ kind: RelativeDateKind; label: string }> = [
  { kind: 'date', label: 'exact date' },
  { kind: 'days-ago', label: 'days ago' },
  { kind: 'weeks-ago', label: 'weeks ago' },
  { kind: 'days-ahead', label: 'days from now' },
  { kind: 'weeks-ahead', label: 'weeks from now' },
];

export function kindOf(r: RelativeDate | null): RelativeDateKind {
  return r ? (`${r.unit}-${r.direction}` as RelativeDateKind) : 'date';
}

export function splitKind(kind: RelativeDateKind): { unit: RelativeDateUnit; direction: RelativeDateDirection } | null {
  if (kind === 'date') return null;
  const [unit, direction] = kind.split('-') as [RelativeDateUnit, RelativeDateDirection];
  return { unit, direction };
}
