/** Shared month-grid math (MN-038 picker, MN-051 calendar). */

export function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function fmtDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 42 cells (6 weeks), Monday-first, covering the given month. */
export function monthMatrix(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from(
    { length: 42 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** #470 — day/week calendar mode nav. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday of the week containing `d` (matches monthMatrix's Monday-first grid). */
export function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

/** The 7 consecutive days of the week containing `d`, Monday first. */
export function weekDays(d: Date): Date[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
