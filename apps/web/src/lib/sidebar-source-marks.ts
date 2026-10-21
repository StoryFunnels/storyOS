/**
 * #1013 — the source marks at the right edge of a view row that reads SEVERAL databases (the prototype's `srcMarks`): the first
 * two databases' glyphs, then "+N" for the rest. A view with one source shows none — its source colour is already on its own
 * glyph, and colour cannot encode a SET, which is the only reason a mark exists.
 *
 * `ids` is the API's `source_database_ids` (databases the viewer cannot read are already omitted, never listed). An id the
 * workspace's database list does not (yet) hold is skipped rather than drawn as a blank mark, but still counts in "+N", so the
 * number never understates how many sources there are.
 */
export const SOURCE_MARKS_SHOWN = 2;

export interface SourceMarkDatabase {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

export interface SourceMarks {
  shown: SourceMarkDatabase[];
  /** How many sources are not drawn (the "+N"). */
  more: number;
}

export function sourceMarks(
  ids: readonly string[] | undefined,
  byId: ReadonlyMap<string, SourceMarkDatabase>,
): SourceMarks | null {
  const unique = [...new Set(ids ?? [])];
  if (unique.length < 2) return null;
  const shown: SourceMarkDatabase[] = [];
  for (const id of unique) {
    if (shown.length === SOURCE_MARKS_SHOWN) break;
    const db = byId.get(id);
    if (db) shown.push(db);
  }
  return { shown, more: unique.length - shown.length };
}
