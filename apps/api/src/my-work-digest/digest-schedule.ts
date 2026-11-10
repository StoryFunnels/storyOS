import { latestScheduleSlot } from '@storyos/schemas/schedule-cadence';
import type { ScheduleTrigger } from '@storyos/schemas/schedule-cadence';
import type { MyWorkEmailPrefs } from '../users/preferences.constants';

/**
 * A slot is only honoured this long after it passes. It absorbs a restart or a slow sweep (the sweep runs every minute), and it is what
 * stops turning the setting on at 15:00 from mailing today's 09:00 digest six hours late.
 */
export const DIGEST_CATCHUP_MS = 30 * 60_000;

/**
 * The slot (an instant) this person's digest is due for at `now`, or null when it is off or no slot is within the catch-up window.
 * The cadence arithmetic is the schedule trigger's (`schedule-cadence`, #1194): daily = Monday to Friday at the person's local time,
 * weekly = the chosen weekday, both in the person's zone (UTC when none is set, never the server's zone).
 */
export function digestSlot(prefs: MyWorkEmailPrefs, now: Date): Date | null {
  if (prefs.frequency === 'off') return null;
  const timezone = prefs.timezone ?? 'UTC';
  const trigger: ScheduleTrigger =
    prefs.frequency === 'daily'
      ? { type: 'schedule', every: 'day', at: prefs.time, weekdays: [1, 2, 3, 4, 5], timezone }
      : { type: 'schedule', every: 'week', at: prefs.time, weekday: prefs.weekday, timezone };
  const slot = latestScheduleSlot(trigger, now, 'UTC');
  if (!slot || now.getTime() - slot.getTime() > DIGEST_CATCHUP_MS) return null;
  return slot;
}

export const digestSourceKey = (userId: string, workspaceId: string, slot: Date) =>
  `my-work-digest:${userId}:${workspaceId}:${slot.toISOString()}`;
