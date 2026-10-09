import { lt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * #849 — a keyset cursor over `(created_at, id)`, newest first.
 *
 * THE BUG THIS REPLACES: the activity cursor was `created_at < cursor`. `created_at` is not
 * unique — every event written in one transaction shares it (Postgres `now()` is the
 * transaction start) — so a page boundary inside such a group made the next query ask for
 * "strictly older than this instant" and the rest of the group was skipped for good. A bulk
 * link of 7 records, read at limit 3, returned 3. Widening to `<=` is not a fix: it returns the
 * boundary row twice. The ordering key has to be UNIQUE, and `id` is.
 *
 * PRECISION: Postgres stores microseconds, a JS `Date` only milliseconds, so a cursor built
 * from `row.createdAt.toISOString()` would sit BEFORE rows from the same millisecond that
 * still belong on the next page. The timestamp therefore travels as the exact text Postgres
 * produced (`cursorTimestampSql`), never as a Date.
 *
 * WHAT THE CURSOR ENCODES: the last row's own `(created_at, id)`. Callers build it from the
 * last row of a page they are about to return, and every such row is one the caller may read
 * (hidden rows are excluded in the query, see ActivityService.hiddenReferenceExclusion), so it
 * never names an event the caller cannot see. It is opaque base64url JSON; clients must not
 * parse it.
 *
 * Cursors minted before this change were a bare base64 timestamp. They still decode (as
 * `legacy`) so a client mid-pagination across a deploy is not broken; they keep the old
 * `<` semantics for that one request only.
 */
export interface KeysetCursor {
  /** exact `created_at`, microsecond ISO-8601 UTC, as text */
  t: string;
  id: string;
}

export type DecodedCursor = { kind: 'keyset'; cursor: KeysetCursor } | { kind: 'legacy'; at: Date } | null;

/** `created_at` as microsecond-exact UTC text, selected alongside the row. */
export function cursorTimestampSql(createdAt: PgColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeKeysetCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeKeysetCursor(raw: string): DecodedCursor {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<KeysetCursor>;
    if (typeof parsed.t === 'string' && ISO_US.test(parsed.t) && typeof parsed.id === 'string' && UUID.test(parsed.id)) {
      return { kind: 'keyset', cursor: { t: parsed.t, id: parsed.id } };
    }
    return null;
  } catch {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : { kind: 'legacy', at };
  }
}

/**
 * The WHERE condition that resumes a newest-first read strictly after `raw`, or undefined when
 * there is nothing to resume from (no cursor, or one that does not parse: ignored, as it always
 * was). Accepts a pre-#849 bare-timestamp cursor (old `<` semantics for that one request).
 * `plainIsoFallback` additionally accepts a RAW ISO string, which the notifications list used to
 * hand out unencoded, so a client paging across a deploy is not sent back to page one.
 */
export function keysetCondition(createdAt: PgColumn, id: PgColumn, raw: string | undefined, plainIsoFallback = false): SQL | undefined {
  if (!raw) return undefined;
  const decoded = decodeKeysetCursor(raw);
  if (decoded?.kind === 'keyset') return keysetBefore(createdAt, id, decoded.cursor);
  if (decoded?.kind === 'legacy') return lt(createdAt, decoded.at);
  if (plainIsoFallback) {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return lt(createdAt, at);
  }
  return undefined;
}

/** Newest-first sort key for merging rows from SEVERAL tables: exact timestamp text, then id. */
export function newestFirst(a: { cursorTs: string; id: string }, b: { cursorTs: string; id: string }): number {
  if (a.cursorTs !== b.cursorTs) return a.cursorTs < b.cursorTs ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** `(created_at, id) < (cursor.t, cursor.id)`: the rows strictly AFTER the cursor, newest first. */
export function keysetBefore(createdAt: PgColumn, id: PgColumn, c: KeysetCursor): SQL {
  return sql`(${createdAt}, ${id}) < (${c.t}::timestamptz, ${c.id}::uuid)`;
}
