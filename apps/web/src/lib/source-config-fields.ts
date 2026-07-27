/**
 * #113 — human-readable labels, help text and light validation for a source
 * provider's config fields, so the "Sync from…" dialog renders real guidance
 * instead of raw snake_case keys and a brittle comma box.
 *
 * Pure and dependency-free on purpose (unit-tested in source-config-fields.unit.test.ts):
 * the dialog feeds it a provider id + field key and gets back a label, and — for
 * list-shaped fields like LinkedIn's `post_urns` — a parser and a validator.
 */

/** snake_case / camelCase → "Title Case", with a few acronyms kept upper. */
export function humanizeKey(key: string): string {
  const ACRONYMS = new Set(['id', 'ids', 'url', 'urls', 'urn', 'urns', 'ig']);
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Explicit labels for keys whose humanized form would still be cryptic. Keyed
 * by the raw config key; anything not listed falls back to `humanizeKey`.
 */
const LABEL_OVERRIDES: Record<string, string> = {
  page_id: 'Facebook Page ID',
  ig_user_id: 'Instagram Business Account ID',
  user_id: 'X user ID',
  post_urns: 'LinkedIn post URNs',
  channel_id: 'Channel',
  video_ids: 'Video IDs',
  paired_source_id: 'Paired videos source',
  monthly_run_cap: 'Monthly run cap',
};

export function configFieldLabel(key: string): string {
  return LABEL_OVERRIDES[key] ?? humanizeKey(key);
}

/** Split a list-shaped field's free text into trimmed, non-empty entries.
 * Accepts one-per-line (preferred) OR comma-separated, so paste-from-anywhere
 * still works. */
export function parseListValue(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Per-field validation error, or null when the entry is acceptable. Kept
 * deliberately small: today only LinkedIn's `post_urns` (each entry must be a
 * `urn:li:…` URN) needs more than the schema's own required-ness check.
 */
export function validateConfigField(
  providerId: string,
  key: string,
  raw: string,
): string | null {
  if (providerId === 'linkedin.org_engagement' && key === 'post_urns') {
    const entries = parseListValue(raw);
    const bad = entries.filter((e) => !/^urn:li:[a-zA-Z]+:.+/.test(e));
    if (bad.length > 0) {
      return `Not a LinkedIn URN: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}. Use one urn:li:… per line, e.g. urn:li:share:123.`;
    }
  }
  return null;
}
