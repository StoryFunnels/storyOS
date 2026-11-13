/**
 * Ticket #1274 (Otto's ruling) — the Home greeting: "Good morning|afternoon|evening, <first name>".
 *
 * Pure, so the boundaries and the name rules are tested. The hour comes from the BROWSER's clock, which the server
 * cannot know: callers must compute this after mount, never during server render (a hydration mismatch otherwise).
 */

import { DEFAULT_REGIONAL, formatLongDate, type Regional } from './format';

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** 05:00–11:59 morning, 12:00–17:59 afternoon, everything else (18:00–04:59) evening. */
export function dayPart(now: Date): DayPart {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'evening';
}

/** The first word of the display name; empty / whitespace-only / missing means "no name". */
export function firstName(displayName: string | null | undefined): string | null {
  const word = displayName?.trim().split(/\s+/)[0];
  return word ? word : null;
}

/** "Good morning, Ana" — or just "Good morning" when the member has no name (never a dangling comma). */
export function greeting(now: Date, displayName: string | null | undefined): string {
  const base = `Good ${dayPart(now)}`;
  const name = firstName(displayName);
  return name ? `${base}, ${name}` : base;
}

/**
 * The Home sub line: today's date in words, then the workspace name — "Tuesday, 20 October · Pinewood Studio". The date
 * comes from the shared formatter (never an ad-hoc toLocale* call), so it follows the member's date-format preference.
 * No workspace name → just the date; the separator is never left dangling.
 */
export function homeSubLine(now: Date, workspaceName: string | null | undefined, regional: Regional = DEFAULT_REGIONAL): string {
  const date = formatLongDate(now, regional);
  const name = workspaceName?.trim();
  return [date, name].filter(Boolean).join(' · ');
}
