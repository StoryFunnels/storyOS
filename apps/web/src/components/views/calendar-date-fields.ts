/**
 * #808 / #825 — which fields a CALENDAR can usefully be built on, and what
 * choosing each one costs, said at the point of choosing.
 *
 * A calendar needs a date to place a card on, and a WRITABLE date to let you move
 * one. `created_at` / `updated_at` pass the first test and fail the second: the
 * view is correct to refuse the drag and says so in a banner (#753), but that is
 * a consequence announced after you have committed. The board solved this class
 * of problem in #225 — list every field, disable the impossible ones with the
 * reason in the user's words, because "a picker that silently omits a field is
 * indistinguishable from a bug". This is that, for the calendar.
 *
 * ONE predicate, imported by the toolbar picker, the New-view default and the
 * empty state — never re-`filter` on `field.type` at a call site (CLAUDE.md,
 * field surfaces; it is how the four earlier copies drifted).
 */
export interface CalendarField {
  type: string;
}

/** Can this field place a card on a day at all? */
export function isCalendarDateField(field: CalendarField): boolean {
  return field.type === 'date' || field.type === 'created_at' || field.type === 'updated_at';
}

/**
 * Why a date-capable field makes a read-only calendar, in the user's words — or
 * null when it is a real, writable date. Not a verdict on whether it may be
 * chosen: a created-at calendar is a legitimate read-only view, which is why the
 * #753 banner stays for any view already built on one.
 */
export function calendarDateDisabledReason(field: CalendarField): string | null {
  if (field.type === 'created_at' || field.type === 'updated_at') {
    return "set automatically, so cards can't be moved";
  }
  return null;
}

/** The fields a calendar can be built on that you can actually schedule with. */
export function editableCalendarDateFields<T extends CalendarField>(fields: T[]): T[] {
  return fields.filter((f) => isCalendarDateField(f) && calendarDateDisabledReason(f) === null);
}

/**
 * The empty-state sentence, or null when the usual "pick one in the toolbar"
 * advice leads somewhere. It dead-ends exactly when the database has NO writable
 * date field: every option the picker would then offer is read-only, so the
 * calendar stays unusable and nothing says why (#825). Names the blocker and the
 * action that fixes it — the shape the gallery's "no Cover control" message has.
 */
export function calendarNoEditableDateMessage(fields: CalendarField[]): string | null {
  if (editableCalendarDateFields(fields).length > 0) return null;
  return 'This database has no editable date field. Add a date field to schedule records here.';
}

/**
 * #808 — "Today" is correct and still reads as broken when the view already
 * shows today: pressing it changes nothing on screen and says nothing. So it is
 * disabled in exactly that state (the caller says why in its title). `week` is
 * the 7 days the view is showing, passed in rather than recomputed here so this
 * can never disagree with what is drawn.
 */
export function isShowingToday(
  mode: 'month' | 'week' | 'day',
  anchor: Date,
  today: Date,
  week: Date[],
): boolean {
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mode === 'month') return anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth();
  if (mode === 'week') return week.some((d) => sameDay(d, today));
  return sameDay(anchor, today);
}
