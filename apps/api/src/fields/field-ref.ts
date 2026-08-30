import { and, eq, isNull } from 'drizzle-orm';
import { fields } from '../db/schema';
import type { Db } from '../db/client';

/**
 * #458 — resolve a field named in a URL path, by id OR by api_name.
 *
 * Every other record-level surface is keyed by api_name: query filters take
 * `{"field":"agents"}`, sorts take `{"field": …}`, and a values patch is keyed
 * by api_name. The `/records/{rec}/links/{field}` and
 * `/records/{rec}/buttons/{field}` routes were the only ones demanding a UUID,
 * and they gave no signal that they did — a caller who had just filtered on
 * `agents` wrote `agents` here and got a 500.
 *
 * The 500 was not a status-code slip. The raw path segment went into
 * `eq(fields.id, …)` against a `uuid` column, so Postgres raised
 * `22P02 invalid input syntax for type uuid: "agents"` (routine
 * `string_to_uuid`, confirmed by observation, not inferred) and the exception
 * escaped the handler. The `NotFoundException` written on the next line was
 * correct and simply unreachable — which is exactly why a well-formed but
 * unknown UUID answered 404 while an api_name did not.
 *
 * This lives in ONE place and both routes call it. Two inline
 * "is it a uuid?" branches is how this codebase has shipped one concept as two
 * drifting copies at least six times (#375, #380, #383, #399, #408, #422); the
 * next person to add a `/{field}` route should call this rather than write a
 * seventh.
 */
const UUID_SHAPED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type FieldRow = typeof fields.$inferSelect;

/**
 * The field this reference names on this database, or `undefined`.
 *
 * Never throws for an unrecognised reference — an unknown field is a fact the
 * caller decides what to do about (all of today's callers 404), not an
 * exception. A reference that is not UUID-shaped is never sent to the uuid
 * column at all, which is what removes the 500.
 *
 * A UUID-shaped reference is looked up by id first and then, only if that
 * misses, by api_name. The fallback costs one query on a path that was about
 * to 404 anyway, and it means a field whose api_name happens to be UUID-shaped
 * stays addressable instead of becoming quietly unreachable.
 */
export async function findFieldByRef(
  db: Db,
  databaseId: string,
  ref: string,
): Promise<FieldRow | undefined> {
  const scoped = (match: ReturnType<typeof eq>) =>
    db.query.fields.findFirst({
      where: and(match, eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });

  if (UUID_SHAPED.test(ref)) {
    const byId = await scoped(eq(fields.id, ref));
    if (byId) return byId;
  }
  return scoped(eq(fields.apiName, ref));
}
