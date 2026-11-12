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
 * (views/empty-database) re-exports it for existing importers.
 */
export function databaseNoun(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return 'item';
  const singular = singularize(trimmed.toLowerCase());
  return singular || 'item';
}

/** Words whose plural is their singular, or which only exist in the plural, so they must not lose a letter ("news" is not "new"). */
const SAME_BOTH_WAYS = new Set(['news', 'series', 'species', 'analytics', 'statistics', 'logistics']);
/** "-ies" words whose singular is "-ie", not "-y" ("movies" is not "movy"). */
const IE_WORDS = new Set(['movies', 'cookies', 'rookies', 'zombies', 'selfies', 'calories']);

function lastWord(s: string): string {
  return s.slice(s.lastIndexOf(' ') + 1);
}

/** The singular of a lower-cased plural name ("companies" → "company", "addresses" → "address", "status" stays). */
function singularize(lower: string): string {
  const w = lastWord(lower);
  if (lower.length <= 3 || SAME_BOTH_WAYS.has(w)) return lower;
  if (IE_WORDS.has(w)) return lower.slice(0, -1);
  if (w.length > 4 && w.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  // "-sses" (addresses), "-xes" (boxes), "-ches"/"-shes" (batches), "-zzes" (quizzes), and "-tuses"/"-nuses"/... (statuses, bonuses).
  if (/(?:ss|x|ch|sh)es$/.test(w) || /(?:t|n|r|p)uses$/.test(w)) return lower.slice(0, -2);
  if (/zzes$/.test(w)) return lower.slice(0, -3);
  // Already singular: "status", "address", "analysis", "bus".
  if (/(?:ss|us|is)$/.test(w)) return lower;
  return lower.endsWith('s') ? lower.slice(0, -1) : lower;
}

/** #149 — plural form for counts ("3 tasks"). Naive by design; the noun is a
 * display nicety, not data, so an odd plural is a cosmetic issue, never a bug. */
export function pluralNoun(noun: string, count: number): string {
  if (count === 1) return noun;
  const w = lastWord(noun);
  if (SAME_BOTH_WAYS.has(w)) return noun;
  if (IE_WORDS.has(`${w}s`)) return `${noun}s`;
  if (/[^aeiou]y$/.test(w)) return `${noun.slice(0, -1)}ies`;
  if (/(?:s|x|ch|sh)$/.test(w)) return `${noun}es`;
  if (w.endsWith('z')) return `${noun}zes`;
  return `${noun}s`;
}
