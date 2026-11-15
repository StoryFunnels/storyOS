import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { records } from '../db/schema';
import { looksLikeUuid } from './uuid';

/**
 * ticket #1295 — the ONE place a `{rec}` path segment becomes a record uuid.
 *
 * `records/{rec}/...` is documented (and the MCP says) "the record uuid or its public number", but every handler downstream
 * (`assertRecordAccess`, the comments / links / versions / attachments services) treats `{rec}` as a uuid only — ticket #613 made a
 * non-uuid a 404 rather than a 500 — so a number reached them as an unknown id. Rather than teach ~37 handlers, the access guard applies
 * this once to `params.rec` before any of them runs, so every route in the family is consistent by construction and a new
 * `records/:rec/...` route is covered without anyone remembering to opt in.
 *
 *   uuid-shaped      -> unchanged (it is a uuid)
 *   canonical digits -> the uuid of THAT database's record with that number, or NIL_UUID when there is none
 *   anything else    -> unchanged (downstream answers 404 exactly as it did before)
 *
 * NIL_UUID is the point of the "none" branch. A number with no record is not rejected here; it becomes an id no record can have, so it
 * takes the very same path a missing uuid takes. Everything after this function (workspace membership, database reach, the restricted
 * -database "Database not found" answer of ADR-0018 (b), per-record access, guest narrowing) therefore answers a number exactly as it
 * answers that record's uuid, and a number for a record the caller cannot read is indistinguishable from a number that does not exist:
 * this function decides nothing about access and returns nothing a caller can see.
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Canonical decimal only: "007", "1e3", "-1", "1.5" are not numbers here, and a Postgres integer column stops at 2^31 - 1. */
const CANONICAL_NUMBER = /^[1-9][0-9]{0,9}$/;
const MAX_NUMBER = 2_147_483_647;

export function looksLikeRecordNumber(value: string): boolean {
  return CANONICAL_NUMBER.test(value) && Number(value) <= MAX_NUMBER;
}

/** `databaseId` is the `{db}` of the same path; a number never resolves outside it. A non-uuid `databaseId` is left for the route to reject. */
export async function resolveRecordRef(db: Db, databaseId: string | undefined, ref: string): Promise<string> {
  if (looksLikeUuid(ref) || !looksLikeRecordNumber(ref)) return ref;
  if (!databaseId || !looksLikeUuid(databaseId)) return ref;
  // trashed rows resolve too: whether a trashed record may be touched is the route's rule for that record's uuid, not ours (restore needs it)
  const [row] = await db
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.databaseId, databaseId), eq(records.number, Number(ref))))
    .orderBy(sql`${records.deletedAt} is not null`, asc(records.createdAt))
    .limit(1);
  return row?.id ?? NIL_UUID;
}
