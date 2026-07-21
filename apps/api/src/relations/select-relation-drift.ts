/**
 * Select↔relation drift detection (MN-286) — the pure matching core, isolated
 * from the DB so it unit-tests cleanly (mirrors the auto-link.ts split).
 *
 * The problem: a database can have BOTH a `select` field (a quick label, e.g.
 * "Project") AND a `relation` field pointing at another database that
 * conceptually means the same grouping (e.g. an `epic` relation to Projects).
 * Nothing keeps them in sync — a record can carry the select label without
 * the relation link, invisible on the target record's own linked-collection
 * view. This module finds, for a given parent record, which select field (on
 * the child database) "means" that parent — by an exact label match against
 * the parent's title — and which child records carry that label without
 * being linked.
 */

export interface SelectFieldRow {
  id: string;
  apiName: string;
  displayName: string;
}

export interface SelectOptionRow {
  id: string;
  fieldId: string;
  label: string;
}

export interface DriftPairing {
  field: SelectFieldRow;
  option: { id: string; label: string };
}

/** Case/whitespace-insensitive comparison key — matches auto-link's normalizeKeyPart default. */
export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Find the first select field whose option set contains a label matching the
 * parent record's title. Returns null when the title is blank (never match
 * on emptiness — every record with a blank title would "match" otherwise) or
 * when no select field/option pairs with it.
 */
export function findDriftPairing(
  selectFields: SelectFieldRow[],
  options: SelectOptionRow[],
  parentTitle: string,
): DriftPairing | null {
  const target = normalizeLabel(parentTitle);
  if (!target) return null;
  for (const field of selectFields) {
    const match = options.find((o) => o.fieldId === field.id && normalizeLabel(o.label) === target);
    if (match) return { field, option: { id: match.id, label: match.label } };
  }
  return null;
}

/** Candidates carrying the matched select value that aren't in the already-linked set. */
export function missingLinks<T extends { id: string }>(
  candidates: T[],
  linkedChildIds: ReadonlySet<string>,
): T[] {
  return candidates.filter((c) => !linkedChildIds.has(c.id));
}
