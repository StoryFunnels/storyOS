/**
 * Auto-link matching (MN-085) — the pure core, isolated from the DB so it unit-tests
 * cleanly. Given the records of both sides and the resolved rules, it decides which
 * A→B links to create, which A records are ambiguous (several targets under a
 * one-to-many cap), and which matched nothing.
 *
 * Direction convention mirrors record_links: `from` is the side-A record, `to` is
 * side-B. Side A is the "many" side for one_to_many — each A links to at most one B.
 */

/** Field types whose values can be compared for equality across databases. */
export const AUTO_LINK_COMPARABLE_TYPES = new Set(['title', 'text', 'url', 'email', 'number', 'date']);

export function isComparableType(type: string): boolean {
  return AUTO_LINK_COMPARABLE_TYPES.has(type);
}

/** A field resolved for matching: its id (to read from record.values) and type. */
export interface MatchField {
  id: string;
  type: string;
}

export interface AutoLinkConfig {
  conditions: Array<{ fieldA: MatchField; fieldB: MatchField }>;
  caseSensitive: boolean;
}

export interface MatchRecord {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

export type Cardinality = 'one_to_many' | 'many_to_many';

/** The value to match on: the title column for a title field, else the JSONB value. */
export function fieldValue(rec: MatchRecord, field: MatchField): unknown {
  return field.type === 'title' ? rec.title : rec.values[field.id];
}

/**
 * Normalize one value to a comparable key part, or null when it's empty / not
 * comparable. Strings are trimmed and (by default) lowercased; empty strings and
 * null/undefined return null so a record with a blank match field never links —
 * otherwise every record with an empty "region" would link to every other.
 */
export function normalizeKeyPart(value: unknown, caseSensitive: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return caseSensitive ? trimmed : trimmed.toLowerCase();
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // arrays / objects (select ids, relations, users) are not comparable across DBs
  return null;
}

const SEP = '\u0000'; // NUL: never appears in field values, so no key collision

/** Composite key across all conditions for one record; null if any part is empty. */
export function recordKey(rec: MatchRecord, config: AutoLinkConfig, side: 'a' | 'b'): string | null {
  const parts: string[] = [];
  for (const cond of config.conditions) {
    const field = side === 'a' ? cond.fieldA : cond.fieldB;
    const part = normalizeKeyPart(fieldValue(rec, field), config.caseSensitive);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join(SEP);
}

export interface PlannedLink {
  fromId: string;
  toId: string;
  aTitle: string;
  bTitle: string;
}

export interface MatchPlan {
  /** Links to create (from = A, to = B), already deduped against existing links. */
  links: PlannedLink[];
  /** A record ids that matched more than one B under a one-to-many cap (skipped). */
  ambiguous: string[];
  /** How many A records matched no B. */
  unmatched: number;
}

/**
 * Plan the links for a set of A records against a set of B records.
 *
 * @param existingCountByA  how many links each A record already has in this relation
 * @param existingPairs     "aId\0bId" pairs that already exist (skip, don't recreate)
 */
export function planAutoLinks(
  aRecords: MatchRecord[],
  bRecords: MatchRecord[],
  config: AutoLinkConfig,
  cardinality: Cardinality,
  existingCountByA: Map<string, number>,
  existingPairs: Set<string>,
): MatchPlan {
  // Index B by its match key so each A is an O(1) lookup, not an O(m) scan.
  const bByKey = new Map<string, MatchRecord[]>();
  for (const b of bRecords) {
    const key = recordKey(b, config, 'b');
    if (key === null) continue;
    const bucket = bByKey.get(key);
    if (bucket) bucket.push(b);
    else bByKey.set(key, [b]);
  }

  const links: PlannedLink[] = [];
  const ambiguous: string[] = [];
  let unmatched = 0;

  for (const a of aRecords) {
    const key = recordKey(a, config, 'a');
    if (key === null) {
      unmatched++;
      continue;
    }
    const candidates = bByKey.get(key) ?? [];
    if (candidates.length === 0) {
      unmatched++;
      continue;
    }

    if (cardinality === 'one_to_many') {
      // Each A links to at most one B. If it already has a link, leave it. If several
      // targets match, it's ambiguous — surface it, never silently pick one.
      if ((existingCountByA.get(a.id) ?? 0) >= 1) continue;
      if (candidates.length > 1) {
        ambiguous.push(a.id);
        continue;
      }
      const b = candidates[0]!;
      links.push({ fromId: a.id, toId: b.id, aTitle: a.title, bTitle: b.title });
    } else {
      // many_to_many: link every matching B not already linked.
      for (const b of candidates) {
        if (existingPairs.has(`${a.id}${SEP}${b.id}`)) continue;
        links.push({ fromId: a.id, toId: b.id, aTitle: a.title, bTitle: b.title });
      }
    }
  }

  return { links, ambiguous, unmatched };
}
