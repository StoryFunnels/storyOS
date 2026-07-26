/**
 * #342 — auto-match a source's incoming provider keys to fields the target
 * database ALREADY has, so mapping doesn't default every row to "+ New … field"
 * and force duplicate columns.
 *
 * Pure and dependency-free on purpose (unit-tested in source-field-match.unit.test.ts):
 * the "Sync from…" dialog feeds it its catalog + the target database's existing
 * fields and gets back, per key, either an existing field to pre-select or the
 * "create a new field" fallback (with the provider's type hint preserved).
 */

export interface CatalogItem {
  key: string;
  label: string;
  suggestedType: string;
  isKey?: boolean;
}

export interface ExistingFieldLike {
  id: string;
  displayName: string;
  apiName: string;
  type: string;
}

export type FieldMatchDestination =
  | { kind: 'existing'; field_id: string }
  | { kind: 'new'; type: string };

/** Case-, spacing- and punctuation-insensitive key for name comparison:
 * "Comment ID", "comment_id" and "commentId" all collapse to "commentid". */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The plain-text field types it's always safe to write arbitrary provider
 * values into (no format validation, no constrained option set). The record
 * Name (`title`) is a plain-text column too (#125). */
const STRING_SAFE = new Set(['text', 'rich_text', 'title']);

/**
 * #125 — provider keys that clearly denote a record's own name/title. When a
 * source has one of these, it should default onto the record Name (a `title`
 * field) so imports get a human-readable name instead of landing nameless.
 */
const TITLE_LIKE_KEYS = new Set(['title', 'name']);

/**
 * Whether a provider key with `suggestedType` can safely be written into an
 * existing field of `existingType`. Conservative on purpose — we never
 * auto-map into a validating field (`url`/`email`) or a constrained one
 * (`select`/`multi_select`) unless the suggested type is the same, so a match
 * can't silently start rejecting rows on the first sync.
 */
export function typesCompatible(suggestedType: string, existingType: string): boolean {
  if (suggestedType === existingType) return true;
  switch (suggestedType) {
    case 'number':
      return existingType === 'number';
    case 'checkbox':
      return existingType === 'checkbox';
    case 'url':
      // A URL string is fine in a url field or any plain-text field.
      return existingType === 'url' || STRING_SAFE.has(existingType);
    case 'text':
    case 'rich_text':
      return STRING_SAFE.has(existingType);
    default:
      // Unknown suggested type: only an exact type match (handled above).
      return false;
  }
}

/**
 * The best existing field for a catalog item, or null if none is a reasonable
 * match. A field matches when its name (display OR api name) normalizes to the
 * item's label OR key AND its type is compatible with the suggested type.
 * Returns the first such field, preserving `fields` order (stable/deterministic).
 */
export function matchExistingField(
  item: CatalogItem,
  fields: ExistingFieldLike[],
): ExistingFieldLike | null {
  const targets = new Set([normalizeFieldName(item.label), normalizeFieldName(item.key)]);
  targets.delete('');
  if (targets.size === 0) return null;
  // #125 — a title-like source key ("Title"/"Name") defaults onto the record
  // Name (the `title` field), even though that field is called "Name" and so
  // never name-matches "title" the ordinary way. Gated on the key being
  // title-like so an arbitrary text key (e.g. "Duration") never grabs Name.
  const itemIsTitleLike = [...targets].some((t) => TITLE_LIKE_KEYS.has(t));
  for (const field of fields) {
    if (field.type === 'title') {
      if (itemIsTitleLike && typesCompatible(item.suggestedType, field.type)) return field;
      continue;
    }
    const nameHit =
      targets.has(normalizeFieldName(field.displayName)) || targets.has(normalizeFieldName(field.apiName));
    if (nameHit && typesCompatible(item.suggestedType, field.type)) return field;
  }
  return null;
}

/**
 * Per-key mapping for a whole catalog: an existing field where one matches,
 * otherwise the "+ New <type> field" fallback carrying the provider's type hint.
 * A given existing field is claimed by at most one key so two provider keys
 * never both write the same column.
 */
export function autoMatchMapping(
  catalog: CatalogItem[],
  fields: ExistingFieldLike[],
): Map<string, FieldMatchDestination> {
  const out = new Map<string, FieldMatchDestination>();
  const claimed = new Set<string>();
  for (const item of catalog) {
    const available = fields.filter((f) => !claimed.has(f.id));
    const match = matchExistingField(item, available);
    if (match) {
      claimed.add(match.id);
      out.set(item.key, { kind: 'existing', field_id: match.id });
    } else {
      out.set(item.key, { kind: 'new', type: item.suggestedType });
    }
  }
  return out;
}
