/**
 * #379 — match a CSV column to a field that already exists.
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

/** Types that cannot receive an imported value, so must never be auto-matched. */
const UNWRITABLE = new Set(['lookup', 'rollup', 'formula', 'button']);

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
    if (UNWRITABLE.has(f.type)) return false;
    // Both names: a CSV exported from StoryOS carries api_names, one typed by a
    // human carries something closer to the display name.
    return normalizeColumnKey(f.displayName) === key || (f.apiName ? normalizeColumnKey(f.apiName) === key : false);
  });

  // Ambiguity means no match. Picking one of two equally-good candidates is a
  // coin flip the user cannot see, and they would have to notice it to undo it.
  return candidates.length === 1 ? candidates[0]! : null;
}
