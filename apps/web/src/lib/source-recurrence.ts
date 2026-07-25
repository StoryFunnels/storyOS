/**
 * #340 — pure helpers for the Sources "Sync from…" recurrence picker. Kept out
 * of the dialog component so the form-state → API-recurrence mapping and the
 * human labels are unit-tested (source-recurrence.unit.test.ts) rather than
 * only exercised through the UI.
 *
 * Wall-clock slots are interpreted in UTC by the scheduler (see the API's
 * recurrence.ts), so the picker deals in plain hour/minute/weekday numbers.
 */

export type SourceRecurrence =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

export type RecurrenceKind = SourceRecurrence['kind'];

/** Default for a new source: daily at 09:00 — matches the API's default. */
export const DEFAULT_RECURRENCE: SourceRecurrence = { kind: 'daily', hour: 9, minute: 0 };

/** 0=Sunday … 6=Saturday, matching JS `Date.getUTCDay()` and the API schema. */
export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const REPEAT_LABELS: Record<RecurrenceKind, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  hourly: 'Every hour',
};

/** The flat form state the picker binds to. */
export interface RecurrenceFormState {
  kind: RecurrenceKind;
  /** "HH:MM" for daily/weekly. */
  timeOfDay: string;
  /** 0..6 for weekly. */
  weekday: number;
  /** 0..59 for hourly. */
  minute: number;
}

export const DEFAULT_RECURRENCE_FORM: RecurrenceFormState = {
  kind: 'daily',
  timeOfDay: '09:00',
  weekday: 1,
  minute: 0,
};

function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':');
  const hour = Math.min(Math.max(Number(h) || 0, 0), 23);
  const minute = Math.min(Math.max(Number(m) || 0, 0), 59);
  return { hour, minute };
}

/** Form state → the API recurrence body. */
export function buildRecurrence(form: RecurrenceFormState): SourceRecurrence {
  if (form.kind === 'hourly') {
    return { kind: 'hourly', minute: Math.min(Math.max(form.minute || 0, 0), 59) };
  }
  const { hour, minute } = parseTimeOfDay(form.timeOfDay);
  if (form.kind === 'weekly') {
    return { kind: 'weekly', weekday: Math.min(Math.max(form.weekday, 0), 6), hour, minute };
  }
  return { kind: 'daily', hour, minute };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A human label for a source's cadence. Prefers the #340 recurrence; falls
 * back to the legacy coarse `schedule` string for sources that predate it.
 */
export function describeRecurrence(
  recurrence: SourceRecurrence | null | undefined,
  schedule: string,
): string {
  if (!recurrence) {
    return { '15m': 'Every 15 minutes', hour: 'Hourly', day: 'Daily' }[schedule] ?? schedule;
  }
  switch (recurrence.kind) {
    case 'hourly':
      return `Hourly at :${pad2(recurrence.minute)}`;
    case 'daily':
      return `Daily at ${pad2(recurrence.hour)}:${pad2(recurrence.minute)} UTC`;
    case 'weekly':
      return `Weekly on ${WEEKDAY_LABELS[recurrence.weekday]} at ${pad2(recurrence.hour)}:${pad2(
        recurrence.minute,
      )} UTC`;
  }
}
