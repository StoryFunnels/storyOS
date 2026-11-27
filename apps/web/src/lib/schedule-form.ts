import { SCHEDULE_MAX_INTERVAL_MINUTES, SCHEDULE_MIN_INTERVAL_MINUTES, scheduleProblems } from '@storyos/schemas/schedule-cadence';

/**
 * Ticket #1318 — the automation editor's schedule row: what "every N minutes" means in the form, as pure rules.
 *
 * The LIMITS and the wording of a refusal are the API's (`scheduleProblems`, the same function the server answers 422 with), imported
 * and not re-typed. What lives here is only how a text box becomes a number and how a stored interval reads back to the person.
 */
export interface MinutesDraft {
  /** What to send, or null while the box holds nothing usable. */
  value: number | null;
  /** A sentence for the person when the box is not a valid interval; null when valid. */
  error: string | null;
}

export const DEFAULT_SCHEDULE_MINUTES = 30;

export function minutesDraft(raw: string): MinutesDraft {
  const text = raw.trim();
  if (text === '') return { value: null, error: 'Enter how many minutes between runs.' };
  const n = Number(text);
  if (!Number.isInteger(n)) return { value: null, error: 'Enter a whole number of minutes.' };
  const [problem] = scheduleProblems({ every: 'minutes', minutes: n });
  if (!problem) return { value: n, error: null };
  // The schema's too-small sentence carries the offending value after a colon ("…every 10 minutes: "minutes" must be… (got 5)");
  // the first clause is the whole message a person needs. The too-large sentence has no such tail and is shown as the API words it.
  return { value: null, error: n < SCHEDULE_MIN_INTERVAL_MINUTES ? `${problem.split(':')[0]}.` : problem };
}

/** Half-hour steps for a time of day (#1191: no native time pickers). A saved time off the grid (09:10) is its own option, first. */
export function halfHourTimes(saved?: string | null): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  return saved && /^\d{2}:\d{2}$/.test(saved) && !out.includes(saved) ? [saved, ...out] : out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * When an every-N-minutes rule actually fires, in one line. Slots run from the start of the day (or of the active window) in steps of
 * N elapsed minutes, so when N divides 60 they land on the same minute marks every hour, and otherwise they drift across the hour.
 */
export function minutesHelper(minutes: number, timeZone: string, windowFrom?: string): string {
  const startMin = windowFrom ? toMinutes(windowFrom) : 0;
  if (minutes >= 1 && 60 % minutes === 0) {
    const marks = Array.from({ length: 60 / minutes }, (_, k) => (startMin + k * minutes) % 60).sort((a, b) => a - b);
    const shown = marks.map((m) => `:${pad(m)}`);
    const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
    return `Runs at ${list} past the hour in ${timeZone}.`;
  }
  return `Runs every ${minutes} minutes from ${windowFrom ?? 'midnight'} in ${timeZone}.`;
}

export { SCHEDULE_MAX_INTERVAL_MINUTES, SCHEDULE_MIN_INTERVAL_MINUTES };
