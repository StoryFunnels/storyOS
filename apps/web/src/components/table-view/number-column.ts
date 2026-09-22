import { systemFieldId } from '@storyos/schemas';

/**
 * #743 — reverses #659's default: the permanent record number ("ID") is
 * visible by default again, using ORDINARY present-means-hidden semantics
 * like every other id in a view's `hidden_field_ids` array. #659 inverted
 * this (default hidden, so presence in the array meant shown) because there
 * was no other way to encode "the user opted back into the old default"
 * using an array that only ever recorded hidden-ness. With the default back
 * to VISIBLE, that problem doesn't exist — absence from the array already
 * means shown, so the synthetic id needs no special-casing at all.
 *
 * `table-view.tsx` (the gutter) and `view-toolbar.tsx` (the Hide-fields
 * picker) both read/write this same array entry — pulled into one tested
 * module so the two can't drift onto different readings of the same id.
 */
export const NUMBER_SYSTEM_FIELD_ID = systemFieldId('number');

/** Is the record number gutter/column hidden? `realNumberFieldId` is the id
 * of a REAL `number` field row when the database happens to have one (rare) —
 * same ordinary semantics either way, default visible. */
export function isNumberColumnHidden(hiddenFieldIds: string[] | undefined, realNumberFieldId?: string): boolean {
  return (hiddenFieldIds ?? []).includes(realNumberFieldId ?? NUMBER_SYSTEM_FIELD_ID);
}

/** Whether a togglable field (from the Hide-fields picker's own field list) is
 * currently shown. */
export function isFieldVisible(hidden: string[], fieldId: string): boolean {
  return !hidden.includes(fieldId);
}

/** The next `hidden_field_ids` array after toggling one field to `nextVisible`. */
export function toggleFieldVisibility(hidden: string[], fieldId: string, nextVisible: boolean): string[] {
  return nextVisible ? hidden.filter((id) => id !== fieldId) : [...hidden.filter((id) => id !== fieldId), fieldId];
}

/** How many of `candidateFieldIds` are currently hidden — for the picker's own
 * "N hidden" trigger label. */
export function countHiddenFields(hidden: string[], candidateFieldIds: ReadonlySet<string>): number {
  return hidden.filter((id) => candidateFieldIds.has(id)).length;
}
