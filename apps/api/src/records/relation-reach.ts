import { eq } from 'drizzle-orm';
import { formulaRefs, type FieldDef, type FormulaNode } from '@storyos/schemas';
import type { Db } from '../db/client';
import { databases, relations } from '../db/schema';
import type { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * #881 / #1308 — what a NARROWED caller (a guest, which includes a token bound to specific spaces or databases) can reach across each
 * relation field of a database, and which derived fields that makes unreadable. Extracted from `RecordsService.narrowedQuerySurface`
 * so the query surface and the usage counter read ONE answer; a second copy of "which links may this caller see" is the shape of every
 * leak the narrowing tickets fixed.
 */

/** Per relation FIELD id: 'full' (the caller reads the whole far side), 'none' (nothing of it), or the far-side record ids they may read. */
export type RelationReach = Map<string, 'full' | 'none' | string[]>;

export async function relationFieldReach(
  db: Db,
  access: AccessService,
  membership: Membership,
  defs: FieldDef[],
): Promise<RelationReach> {
  const reach: RelationReach = new Map();
  for (const def of defs) {
    if (def.type !== 'relation') continue;
    const relation = await db.query.relations.findFirst({
      where: eq(relations.id, def.config['relation_id'] as string),
    });
    if (!relation) {
      reach.set(def.id, 'none'); // dangling: no links to see
      continue;
    }
    const targetId = def.config['side'] === 'a' ? relation.databaseBId : relation.databaseAId;
    const target = await db.query.databases.findFirst({
      where: eq(databases.id, targetId),
      columns: { id: true, spaceId: true },
    });
    if (!target) {
      reach.set(def.id, 'none');
    } else if ((await access.effectiveForDatabase(membership, target)) !== null) {
      reach.set(def.id, 'full');
    } else {
      const scoped = await access.visibleRecordIds(membership, target);
      reach.set(def.id, scoped && scoped.ids.size > 0 ? [...scoped.ids] : 'none');
    }
  }
  return reach;
}

/**
 * A lookup, rollup or formula is TAINTED when it is derived (directly, or through another derived field) from a relation whose far side
 * the caller cannot read in full: its value, or merely whether it has one, would reveal what is on the far side.
 */
export function derivedFieldTaint(
  defs: FieldDef[],
  byApiName: Map<string, FieldDef>,
  reach: RelationReach,
): (def: FieldDef) => boolean {
  const isFull = (fieldId: string) => reach.get(fieldId) === 'full';
  const memo = new Map<string, boolean>();
  const tainted = (def: FieldDef): boolean => {
    const known = memo.get(def.id);
    if (known !== undefined) return known;
    memo.set(def.id, false); // cycle guard: a cycle adds nothing new
    let result = false;
    if (def.type === 'rollup' || def.type === 'lookup') {
      const via = defs.find((d) => d.id === def.config['relation_field_id']);
      result = !!via && via.type === 'relation' && !isFull(via.id);
    } else if (def.type === 'formula') {
      const ast = def.config['ast'] as FormulaNode | undefined;
      for (const apiName of ast ? formulaRefs(ast) : []) {
        const target = byApiName.get(apiName);
        if (!target) continue;
        if (target.type === 'relation' ? !isFull(target.id) : tainted(target)) {
          result = true;
          break;
        }
      }
    }
    memo.set(def.id, result);
    return result;
  };
  return tainted;
}
