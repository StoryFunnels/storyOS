/**
 * #379 — match a source column to a field that already exists.
 *
 * MOVED here from apps/web in #432, not copied. The copy-record feature needs
 * the identical rules on the API side, and forking them is the exact habit
 * CLAUDE.md's field-surface rules exist to stop — #375, #399 and #408 are all
 * one concept that grew a second hardcoded copy. A matcher that disagrees with
 * itself across two processes would auto-map a column in the wizard and refuse
 * it in the copy dialog, which is worse than either behaviour alone.
 *
 * The wizard used to default EVERY column to "create a new field", so importing
 * into a database you already set up proposed duplicating its whole schema, and
 * the only thing between you and `Website` / `Website 2` was remapping every
 * dropdown by hand. It also sharpened #372's trap: after a failed run the fields
 * exist, and the retry offered to create them a second time.
 *
 * Pure and separately testable on purpose — the rules below are the kind that
 * look obvious and are easy to get subtly wrong.
 */

/**
 * Types that cannot receive an imported value, so must never be auto-matched.
 *
 * #477 — audited against every member of the `field_type` enum
 * (apps/api/src/db/schema.ts), not just extended with the one type that was
 * reported. A raw CSV cell is always a plain string (or, for a multi-value
 * column, an array of strings); a type belongs here exactly when
 * `validateRecordValues` (record-values.ts) rejects THAT shape outright,
 * regardless of content — never because a value might fail to parse.
 *
 *   id / created_at / updated_at / created_by — read-only. Rejected verbatim
 *     ("is read-only") before any coercion is attempted.
 *   lookup / rollup / formula / button — computed. Already here; unchanged.
 *   relation — the type that was reported. A relation value is a list of
 *     record ids/numbers (`relations: 'collect'` mode), never a bare string;
 *     a plain CSV cell fails with "expected an array of record ids or
 *     numbers" on every row, which is exactly the defect Nadia found.
 *   attachment — found by this audit, not previously reported. An
 *     attachment value is an array of attachment ids the upload endpoint
 *     already created; `coerce()`'s attachment case rejects anything that
 *     isn't already such an array with "expected an array of attachment
 *     ids" — the identical shape of failure as relation, just never noticed
 *     because no database happens to have two fields sharing a name the way
 *     the "Roast" relation did.
 *
 * Deliberately NOT here, because each of these DOES accept a plain string
 * and can succeed depending on its content — the set is about the type
 * shape, not about every value of that type parsing:
 *   title — the record name; a plain string is exactly its native value.
 *   text, rich_text, number, checkbox, date, url, email, color — ordinary
 *     scalars `coerce()` parses a string into.
 *   select, multi_select, workflow — resolved against the field's own
 *     option labels (or create a new option), which a CSV cell often names.
 *   user — resolved against the workspace directory by id, email or name,
 *     any of which a CSV cell can already be.
 */
export const UNWRITABLE_FIELD_TYPES = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'lookup',
  'rollup',
  'formula',
  'button',
  'relation',
  'attachment',
]);

export interface MatchableField {
  id: string;
  displayName: string;
  apiName?: string;
  type: string;
}

/**
 * Lowercase, strip everything that is not a letter or digit. Makes
 * `company_name`, `Company Name` and `companyName` the same key.
 */
export function normalizeColumnKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The field a column should pre-select, or null.
 *
 * EXACT normalised equality only — no fuzzy matching, deliberately. Levenshtein
 * or prefix matching maps `contact_email` onto `email`, and a wrong
 * pre-selection is worse than none: it looks deliberate, so nobody re-checks it.
 * A near-miss creates a new field instead, which the user can see and change.
 */
export function matchExistingField(
  column: string,
  fields: MatchableField[],
): MatchableField | null {
  const key = normalizeColumnKey(column);
  if (!key) return null;

  const candidates = fields.filter((f) => {
    // A value cannot be written into a computed field, so matching one would
    // pre-select a destination that is guaranteed to fail.
    if (UNWRITABLE_FIELD_TYPES.has(f.type)) return false;
    // Both names: a CSV exported from StoryOS carries api_names, one typed by a
    // human carries something closer to the display name.
    return normalizeColumnKey(f.displayName) === key || (f.apiName ? normalizeColumnKey(f.apiName) === key : false);
  });

  // Ambiguity means no match. Picking one of two equally-good candidates is a
  // coin flip the user cannot see, and they would have to notice it to undo it.
  return candidates.length === 1 ? candidates[0]! : null;
}
