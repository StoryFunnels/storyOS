/**
 * #806 — how a scalar in an Activity line is shown.
 *
 * The API resolves option ids to labels (#335, `renderValue`) but leaves every
 * other stored value as it was written. A person field stores the member's opaque
 * USER ID, so the line read "changed Assignee: empty → HGBSKwldCwXc8wTChjGdKI6Q…".
 * #796 fixed the rich_text branch of this same formatter and left the scalar one.
 *
 * Driven by FIELD TYPE, not by field name: every type whose stored scalar is a
 * user id resolves through the same member lookup (`user`, plus the two audit
 * types `created_by` / `updated_by`). Types considered and deliberately left
 * as-is: select / multi_select / workflow (the API already returns labels),
 * relation (changes arrive as relation.* events, not field diffs), rich_text
 * (its own block diff, #796), text / number / date / checkbox (the value IS the
 * display value; formatting dates here would make history the one surface that
 * does, which #335 refused).
 *
 * An id with no matching member resolves to the SAME fallback the record-history
 * panel already uses, never to the id.
 */
export const USER_ID_FIELD_TYPES: ReadonlySet<string> = new Set(['user', 'created_by', 'updated_by']);

export const REMOVED_MEMBER_LABEL = '(removed member)';

export function formatActivityValue(
  value: unknown,
  fieldType: string | undefined,
  memberName: (id: string) => string | undefined,
): string {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return value.map((v) => formatActivityValue(v, fieldType, memberName)).join(', ');
  if (fieldType && USER_ID_FIELD_TYPES.has(fieldType) && typeof value === 'string') {
    return memberName(value) ?? REMOVED_MEMBER_LABEL;
  }
  return String(value);
}
