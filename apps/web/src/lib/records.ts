/**
 * Pretty record URLs (MN-087): `/w/{ws}/d/{db}/r/{title-slug}-{number}`. The
 * trailing number is the real key; the slug is cosmetic. Falls back to the UUID
 * when a record has no number yet (older links keep working via the resolver).
 */
export function recordSlug(
  title: string | null | undefined,
  number: number | null | undefined,
): string | null {
  if (number === null || number === undefined) return null;
  const base = (title ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base ? `${base}-${number}` : String(number);
}

export function recordHref(
  ws: string,
  db: string,
  rec: { id: string; title?: string | null; number?: number | null },
): string {
  return `/w/${ws}/d/${db}/r/${recordSlug(rec.title, rec.number) ?? rec.id}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a `[rec]` route segment into a lookup: a UUID (legacy / fallback) or a
 * trailing `-{number}` (pretty). Returns `{ kind: 'id' | 'number', value }`.
 */
export function parseRecordParam(seg: string): { kind: 'id'; value: string } | { kind: 'number'; value: number } {
  const raw = decodeURIComponent(seg);
  if (UUID_RE.test(raw)) return { kind: 'id', value: raw };
  const m = raw.match(/(\d+)$/);
  if (m) return { kind: 'number', value: Number.parseInt(m[1]!, 10) };
  return { kind: 'id', value: raw };
}
