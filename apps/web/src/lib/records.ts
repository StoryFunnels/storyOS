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

/** The `[rec]` route segment for a record — the pretty `slug-{number}` when it
 * has a number, else the UUID. Shared by `recordHref` and the split-screen panel
 * (#146), so a panel opened for a record keys its query the same way the record
 * page would, reusing React Query's cache instead of refetching. */
export function recordSegment(
  rec: { id: string; title?: string | null; number?: number | null },
): string {
  return recordSlug(rec.title, rec.number) ?? rec.id;
}

export function recordHref(
  ws: string,
  db: string,
  rec: { id: string; title?: string | null; number?: number | null },
): string {
  return `/w/${ws}/d/${db}/r/${recordSegment(rec)}`;
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

/**
 * #149 — the friendly singular noun for a database, derived from its display name
 * ("Tasks" → "task"). End-user copy should say "task"/"client"/"invoice" — the
 * operator's own word — not the schema word "record"/"entity". Falls back to
 * "item" (Notion's default) when there's no name to work from.
 *
 * Lives here rather than in a view component so every surface (batch bar, table,
 * empty states, dialogs) can share ONE definition; the previous home
 * (views/empty-state) re-exports it for existing importers.
 */
export function databaseNoun(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return 'item';
  const lower = trimmed.toLowerCase();
  // Strip a trailing plural "s" (but keep short words like "os" intact).
  const singular = lower.length > 3 && lower.endsWith('s') ? lower.slice(0, -1) : lower;
  return singular || 'item';
}

/** #149 — plural form for counts ("3 tasks"). Naive by design; the noun is a
 * display nicety, not data, so an odd plural is a cosmetic issue, never a bug. */
export function pluralNoun(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}
