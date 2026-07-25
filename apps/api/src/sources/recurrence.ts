import type { SourceRecurrence, SourceSchedule } from '@storyos/schemas';

/**
 * #340 — the wall-clock recurrence engine for the Sources scheduler. Pure and
 * dependency-free so it is unit-tested directly (recurrence.unit.test.ts): the
 * scheduler still ticks every 60s (sources.service.ts), but a source with a
 * `recurrence` runs when its chosen wall-clock slot has passed since the last
 * sync — NOT "every N minutes since creation".
 *
 * All wall-clock math is in UTC. `hour`/`minute`/`weekday` are interpreted as
 * UTC-of-day / UTC-day-of-week, which keeps the "did this slot pass yet?"
 * decision deterministic and testable regardless of server timezone.
 */

/**
 * The most recent wall-clock instant at or before `now` that matches the
 * recurrence pattern. A run is due iff the source has not synced since this
 * instant.
 */
export function previousSlot(recurrence: SourceRecurrence, now: Date): Date {
  switch (recurrence.kind) {
    case 'hourly': {
      // Most recent `:minute` past the hour. If this hour's slot is still in
      // the future, step back an hour.
      const slot = new Date(now);
      slot.setUTCMinutes(recurrence.minute, 0, 0);
      if (slot.getTime() > now.getTime()) slot.setUTCHours(slot.getUTCHours() - 1);
      return slot;
    }
    case 'daily': {
      const slot = new Date(now);
      slot.setUTCHours(recurrence.hour, recurrence.minute, 0, 0);
      if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
      return slot;
    }
    case 'weekly': {
      const slot = new Date(now);
      slot.setUTCHours(recurrence.hour, recurrence.minute, 0, 0);
      // Rewind to the target weekday (0..6). `dayDiff` is how many days back
      // the most recent target weekday is; if it lands on today but the
      // time-of-day slot is still ahead, go a full week back.
      const dayDiff = (slot.getUTCDay() - recurrence.weekday + 7) % 7;
      slot.setUTCDate(slot.getUTCDate() - dayDiff);
      if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 7);
      return slot;
    }
  }
}

/**
 * Whether a recurrence-scheduled source is due at `now`, given when it last
 * synced. Never-synced (`lastSyncAt == null`) sources are due as soon as one
 * scheduled slot has occurred — i.e. immediately, since `previousSlot` is
 * always in the past.
 */
export function isRecurrenceDue(
  recurrence: SourceRecurrence,
  lastSyncAt: Date | null,
  now: Date,
): boolean {
  if (!lastSyncAt) return true;
  return lastSyncAt.getTime() < previousSlot(recurrence, now).getTime();
}

/**
 * Derive the legacy coarse `schedule` string a recurrence corresponds to, so
 * the not-null `sources.schedule` column and its `sources_status_schedule_idx`
 * index stay populated even for recurrence-driven sources. This value is NOT
 * used for scheduling when a recurrence is present — it is purely a
 * back-compat shadow of the recurrence's cadence.
 */
export function scheduleFromRecurrence(recurrence: SourceRecurrence): SourceSchedule {
  switch (recurrence.kind) {
    case 'hourly':
      return 'hour';
    case 'daily':
    case 'weekly':
      return 'day';
  }
}
