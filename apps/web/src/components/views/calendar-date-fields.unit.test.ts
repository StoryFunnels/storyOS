import { describe, expect, it } from 'vitest';
import {
  calendarDateDisabledReason,
  calendarNoEditableDateMessage,
  editableCalendarDateFields,
  isCalendarDateField,
  isShowingToday,
} from './calendar-date-fields';

const f = (type: string) => ({ type });

describe('calendar date fields (#808/#825)', () => {
  it('a real date is usable; created_at and updated_at say why they are not movable', () => {
    expect(calendarDateDisabledReason(f('date'))).toBeNull();
    expect(calendarDateDisabledReason(f('created_at'))).toMatch(/can't be moved/);
    expect(calendarDateDisabledReason(f('updated_at'))).toMatch(/can't be moved/);
  });

  // What the filter must KEEP: system dates stay date-CAPABLE (a created-at calendar is legitimate)…
  it('still lists system dates as date-capable, and nothing else', () => {
    for (const t of ['date', 'created_at', 'updated_at']) expect(isCalendarDateField(f(t)), t).toBe(true);
    for (const t of ['text', 'number', 'select', 'user', 'checkbox', 'formula']) expect(isCalendarDateField(f(t)), t).toBe(false);
  });

  it('editable fields exclude system dates', () => {
    const fields = [f('title'), f('created_at'), f('date'), f('updated_at'), f('date')];
    expect(editableCalendarDateFields(fields)).toHaveLength(2);
  });

  describe('calendarNoEditableDateMessage', () => {
    it('names the blocker when only system dates exist', () => {
      expect(calendarNoEditableDateMessage([f('title'), f('created_at'), f('updated_at')])).toMatch(/no editable date field/);
    });
    it('names the blocker when there is no date field at all', () => {
      expect(calendarNoEditableDateMessage([f('title'), f('text')])).toMatch(/Add a date field/);
    });
    it('says nothing when a real date exists — the usual advice leads somewhere', () => {
      expect(calendarNoEditableDateMessage([f('created_at'), f('date')])).toBeNull();
    });
  });
});

describe('isShowingToday (#808)', () => {
  const today = new Date(2026, 9, 1); // Thu 1 Oct 2026
  const week = [28, 29, 30, 1, 2, 3, 4].map((d, i) => new Date(2026, i < 3 ? 8 : 9, d));

  it('month: same month and year only', () => {
    expect(isShowingToday('month', new Date(2026, 9, 1), today, week)).toBe(true);
    expect(isShowingToday('month', new Date(2026, 8, 1), today, week)).toBe(false);
    expect(isShowingToday('month', new Date(2025, 9, 1), today, week)).toBe(false);
  });
  it('week: when the shown week contains today', () => {
    expect(isShowingToday('week', today, today, week)).toBe(true);
    expect(isShowingToday('week', today, today, week.map((d) => new Date(d.getTime() + 7 * 864e5)))).toBe(false);
  });
  it('day: only that day', () => {
    expect(isShowingToday('day', new Date(2026, 9, 1), today, week)).toBe(true);
    expect(isShowingToday('day', new Date(2026, 9, 2), today, week)).toBe(false);
  });
});
