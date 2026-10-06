/**
 * #825 (was #788's G3) — which fields can be a gallery card's cover.
 *
 * An attachment is the original answer. A database that references images BY URL
 * (imported or synced data — common, ordinary) could not use the gallery's cover at
 * all, which made a whole view type unavailable for a legitimate case. So a URL —
 * or a plain text — field is accepted too.
 *
 * The caveat is built here, not assumed: a text/URL field is NOT guaranteed to hold
 * an image. `coverImageUrl` refuses anything that is not an http(s) URL (a
 * `javascript:` string in a text column must never reach an <img>/href), and the
 * card falls back to its no-cover rendering when the image fails to load — per
 * card, never per view, so one bad URL cannot blank the gallery.
 *
 * ONE predicate, imported by the toolbar picker, the gallery's resolver and the
 * "no cover control" notice — never re-`filter` on `field.type` at a call site
 * (the picker and its renderer must widen together, or one of them lies).
 */
export interface CoverField {
  type: string;
}

export function isCoverField(field: CoverField): boolean {
  return field.type === 'attachment' || field.type === 'url' || field.type === 'text';
}

/** Text-valued covers (as opposed to an attachment's file list). */
export function isUrlCoverField(field: CoverField): boolean {
  return field.type === 'url' || field.type === 'text';
}

/** The URL to load, or null when the value is not an http(s) URL. */
export function coverImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
