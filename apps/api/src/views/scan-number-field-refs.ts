import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fields } from '../db/schema';
import { scanConfigForNumberRefs } from './number-field-ref-rewrite';

export interface NumberFieldRefHit {
  viewId: string;
  name: string;
  locations: string[];
  /** Set when the reference cannot be attributed to the deprecated system
   * field OR to a user field: a space-level view has no single database, so
   * `number` in it is ambiguous. Counted as a hit (it blocks AC3) but never
   * rewritten automatically. */
  reason?: 'space_view_unresolved';
}

/**
 * Databases in which `number` is a REAL user field (not the deprecated system
 * one). The resolver is explicit that real fields win — `systemFieldDefsFor`
 * only adds a system field "not already provided by a real field row" — so in
 * these databases a view's `field: 'number'` means the user's own field, which
 * holds different values (a synced GitHub issue number, say, not the StoryOS
 * record number). Rewriting it to `id` would silently change what that filter
 * or sort selects. A soft-deleted field no longer shadows the system one.
 */
export async function databasesWithUserNumberField(db: Pick<Db, 'selectDistinct'>): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ databaseId: fields.databaseId })
    .from(fields)
    .where(and(eq(fields.apiName, 'number'), eq(fields.isSystem, false), isNull(fields.deletedAt)));
  return new Set(rows.map((r) => r.databaseId));
}

/**
 * Scan every (non-deleted) view's config for a remaining reference to the
 * deprecated `number` api_name / `__sys_number` id (#764 AC2: "a query run
 * AFTER the migration proves zero stored view configs still reference
 * `number` — the proof is a count, not a belief"). Trashed views are
 * excluded deliberately: they're unreachable and never compiled, so a stray
 * reference there can't ever break a live filter — the same reasoning
 * structural soft-delete elsewhere in this codebase already applies.
 *
 * Views in a database where `number` is a real user field are NOT hits: that
 * reference is to the user's field and survives removal of the system one.
 */
export async function scanNumberFieldRefs(db: Db): Promise<NumberFieldRefHit[]> {
  const userNumber = await databasesWithUserNumberField(db);
  const rows = await db.query.views.findMany({
    columns: { id: true, name: true, config: true, databaseId: true },
    where: (v, { isNull: isNullOp }) => isNullOp(v.deletedAt),
  });
  const hits: NumberFieldRefHit[] = [];
  for (const row of rows) {
    if (row.databaseId !== null && userNumber.has(row.databaseId)) continue;
    const result = scanConfigForNumberRefs(row.config);
    if (!result.hit) continue;
    hits.push({
      viewId: row.id,
      name: row.name,
      locations: result.locations,
      ...(row.databaseId === null ? { reason: 'space_view_unresolved' as const } : {}),
    });
  }
  return hits;
}
