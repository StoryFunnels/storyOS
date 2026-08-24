export interface TitleTarget {
  id: string;
  title: string;
}

/**
 * Field types that can identify a record, and so may be used as a match key —
 * for a relation column (#377) or an upsert key (#378).
 *
 * Deliberately narrow. Offering every field on the target would invite matching
 * on a checkbox or a date, where thousands of records share a value and every
 * row reports an ambiguity. `title` is included because it is the existing
 * behaviour and still the right default for a human-written CSV.
 */
export const MATCHABLE_KEY_TYPES = ['title', 'text', 'number', 'email', 'url', 'id'] as const;

export function isMatchableKeyType(type: string): boolean {
  return (MATCHABLE_KEY_TYPES as readonly string[]).includes(type);
}

/**
 * Normalise a value to a match key.
 *
 * Case- and whitespace-tolerant, because a CSV round-trips through spreadsheets
 * that pad cells and change capitalisation. #378 requires key matching to be
 * tolerant "in the same way relation matching is", so both go through here —
 * one implementation, not two that drift.
 */
export function matchKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export interface MatchEntry {
  id: string;
  /** The value being matched ON — a title, or any other identifying field. */
  key: unknown;
}

/**
 * Build a key → id index over ANY identifying field of a target database.
 *
 * `null` marks a key shared by two or more records, so the caller warns instead
 * of guessing. That distinction is the whole point: #377's founder CSV carries
 * both `company_id` (stable) and `company_name` (a display name), and titles
 * duplicate, get renamed, and substring-collide — the same trap
 * docs/product/formulas.md documents for `contains`, where "Acme" inside "Acme
 * Corp" silently matched the wrong record.
 *
 * Generalised from buildTitleIndex, which this now backs.
 */
export function buildMatchIndex(entries: MatchEntry[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const e of entries) {
    const key = matchKey(e.key);
    if (!key) continue; // an empty key identifies nothing
    map.set(key, map.has(key) ? null : e.id);
  }
  return map;
}

/**
 * Build a title(lowercased) → id index for one target database, matching CSV's
 * "match relation cells by title" trick (MN-052) — `null` marks a title shared
 * by two or more records so the caller can warn instead of guessing which one
 * was meant.
 */
export function buildTitleIndex(targets: TitleTarget[]): Map<string, string | null> {
  // Matching on the title is just the default case of matching on a field.
  return buildMatchIndex(targets.map((t) => ({ id: t.id, key: t.title })));
}

/**
 * A relation cell may name several targets, comma-separated — the shape CSV
 * export writes (MN-075), so import must read it back that way or the round-trip
 * silently drops every target but the first. A title containing a comma survives
 * because the source's own parser already unquoted the cell; this only splits
 * the top level.
 */
export function splitTargets(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ResolvedTargets {
  hits: string[];
  warnings: string[];
}

/**
 * Resolve a raw relation cell against a title index, collecting one warning
 * message per miss/ambiguous target instead of failing the whole record — the
 * per-cell degradation contract every importer shares (MN-052 dry-run rules).
 */
export function resolveTargetsByTitle(index: Map<string, string | null>, raw: string): ResolvedTargets {
  return resolveTargets(index, raw, 'titled');
}

/**
 * Resolve a raw relation cell against a match index, collecting one warning per
 * miss or ambiguity instead of failing the record — the per-cell degradation
 * contract every importer shares. #377 requires this explicitly: a broken link
 * must never fail the import.
 *
 * `keyLabel` names what was matched on, so the warning reads "no record with
 * company_id \"perseusdefense\"" rather than the misleading "no record titled".
 */
export function resolveTargets(
  index: Map<string, string | null>,
  raw: string,
  keyLabel: string,
): ResolvedTargets {
  const hits: string[] = [];
  const warnings: string[] = [];
  for (const value of splitTargets(raw)) {
    const hit = index.get(matchKey(value));
    if (hit === undefined) warnings.push(`no record ${keyLabel} "${value}"`);
    // Ambiguity is REPORTED, never silently resolved. Picking one of two
    // matches overwrites or links the wrong record, invisibly.
    else if (hit === null) warnings.push(`"${value}" matches more than one record — ${keyLabel} is not unique`);
    else hits.push(hit);
  }
  return { hits, warnings };
}
