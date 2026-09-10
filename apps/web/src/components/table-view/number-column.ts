import { systemFieldId } from '@storyos/schemas';

/**
 * #659 — the permanent record number's visibility now defaults to HIDDEN
 * (previously default-visible, #289), which makes it the ONE entry in a
 * view's `hidden_field_ids` array whose polarity is backwards: every other
 * id means "hidden when present"; this one means "explicitly shown when
 * present", because there is no other way to record "the user opted back
 * into the old default" using an array that only ever recorded hidden-ness.
 *
 * `table-view.tsx` (the gutter) and `view-toolbar.tsx` (the Hide-fields
 * picker) both have to read/write this same inverted bit — pulled into one
 * tested module so the two never drift onto different readings of the same
 * array entry, the exact failure mode field-surfaces.md warns about.
 *
 * Only the SYNTHETIC id inverts. A database with a real, stored `number`
 * field row is unaffected by any of this — that field renders as an ordinary
 * column via the generic fields list, which reads presence-means-hidden for
 * every id including that one; inverting it too would contradict the
 * generic list's own reading of the identical id.
 */
export const NUMBER_SYSTEM_FIELD_ID = systemFieldId('number');

/** Is the record number gutter/column hidden? `realNumberFieldId` is the id
 * of a REAL `number` field row when the database happens to have one (rare;
 * ordinary present-means-hidden semantics apply there, unaffected by #659). */
export function isNumberColumnHidden(hiddenFieldIds: string[] | undefined, realNumberFieldId?: string): boolean {
  const hidden = new Set(hiddenFieldIds ?? []);
  if (realNumberFieldId) return hidden.has(realNumberFieldId);
  return !hidden.has(NUMBER_SYSTEM_FIELD_ID);
}

/** Whether a togglable field (from the Hide-fields picker's own field list) is
 * currently shown — inverted only for the synthetic number id. */
export function isFieldVisible(hidden: string[], fieldId: string): boolean {
  return fieldId === NUMBER_SYSTEM_FIELD_ID ? hidden.includes(fieldId) : !hidden.includes(fieldId);
}

/** The next `hidden_field_ids` array after toggling one field to `nextVisible`. */
export function toggleFieldVisibility(hidden: string[], fieldId: string, nextVisible: boolean): string[] {
  const shouldBePresent = fieldId === NUMBER_SYSTEM_FIELD_ID ? nextVisible : !nextVisible;
  return shouldBePresent ? [...hidden.filter((id) => id !== fieldId), fieldId] : hidden.filter((id) => id !== fieldId);
}

/** How many of `candidateFieldIds` are currently hidden — for the picker's own
 * "N hidden" trigger label. A plain `hidden.length` over/under-counts by one
 * whenever the number entry is a candidate, since its presence means shown. */
export function countHiddenFields(hidden: string[], candidateFieldIds: ReadonlySet<string>): number {
  const numberIsCandidate = candidateFieldIds.has(NUMBER_SYSTEM_FIELD_ID);
  const ordinaryHidden = hidden.filter((id) => id !== NUMBER_SYSTEM_FIELD_ID).length;
  const numberHidden = numberIsCandidate && !hidden.includes(NUMBER_SYSTEM_FIELD_ID) ? 1 : 0;
  return ordinaryHidden + numberHidden;
}
