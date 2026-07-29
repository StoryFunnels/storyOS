/**
 * Pure builders for @/# rich-text mentions (#139, extends #140).
 *
 * Kept dependency-free (no BlockNote/React imports) so the mapping — search hit
 * -> stored mention node, and the "#<number> Title" picker label — is unit
 * testable in the node vitest env without booting the editor.
 */

/** Stored inline-mention props. The id is durable; label/db are snapshots so a
 *  mention still renders (and a #record stays navigable) before it re-resolves. */
export interface MentionProps {
  kind: string;
  id: string;
  label: string;
  db: string;
}

/** A record hit from the grant-scoped workspace search endpoint. */
export interface SearchRecord {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
  number?: number | null;
}

/** A workspace member as offered in the @ picker. */
export interface MemberUser {
  id: string;
  name: string;
  image?: string | null;
}

/** Mention node props for a person picked from the @ menu. */
export function userMentionProps(u: MemberUser): MentionProps {
  return { kind: 'user', id: u.id, label: u.name, db: '' };
}

/** Mention node props for a record picked from the # menu — carries `db` so the
 *  chip links to the record and can resolve its live title. */
export function recordMentionProps(r: SearchRecord): MentionProps {
  return { kind: 'record', id: r.id, label: r.title ?? '', db: r.database_id };
}

/**
 * The inline content inserted at the caret: the mention node plus a trailing
 * space. This is exactly what BlockNote serializes into the stored document, so
 * a mention survives save/reload as structured content (not a flattened string).
 */
export function mentionInsertContent(props: MentionProps): [{ type: 'mention'; props: MentionProps }, string] {
  return [{ type: 'mention', props }, ' '];
}

/** Row shape for the # record picker: the faint #<number>, the title, and the
 *  owning database (as subtext). Missing numbers degrade to null (no "#"). */
export function recordRowLabel(r: SearchRecord): {
  number: number | null;
  title: string;
  database: string;
} {
  return {
    number: r.number ?? null,
    title: r.title || 'Untitled',
    database: r.database_name,
  };
}

/** Case-insensitive name filter for the @ picker's local member list. */
export function filterMembers<T extends { name: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return members;
  return members.filter((m) => m.name.toLowerCase().includes(q));
}
