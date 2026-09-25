import type { Db } from '../db/client';
import { scanConfigForNumberRefs } from './number-field-ref-rewrite';

export interface NumberFieldRefHit {
  viewId: string;
  name: string;
  locations: string[];
}

/**
 * Scan every (non-deleted) view's config for a remaining reference to the
 * deprecated `number` api_name / `__sys_number` id (#764 AC2: "a query run
 * AFTER the migration proves zero stored view configs still reference
 * `number` — the proof is a count, not a belief"). Trashed views are
 * excluded deliberately: they're unreachable and never compiled, so a stray
 * reference there can't ever break a live filter — the same reasoning
 * structural soft-delete elsewhere in this codebase already applies.
 */
export async function scanNumberFieldRefs(db: Db): Promise<NumberFieldRefHit[]> {
  const rows = await db.query.views.findMany({
    columns: { id: true, name: true, config: true },
    where: (v, { isNull }) => isNull(v.deletedAt),
  });
  const hits: NumberFieldRefHit[] = [];
  for (const row of rows) {
    const result = scanConfigForNumberRefs(row.config);
    if (result.hit) hits.push({ viewId: row.id, name: row.name, locations: result.locations });
  }
  return hits;
}
