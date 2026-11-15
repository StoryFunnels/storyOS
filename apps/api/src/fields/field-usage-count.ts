import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FieldDef } from '@storyos/schemas';
import type { Db } from '../db/client';
import { fields, recordLinks, records, relations } from '../db/schema';
import type { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { derivedFieldTaint, relationFieldReach } from '../records/relation-reach';
import {
  FIELD_VALUE_STORAGE,
  recordRowHasValueSql,
  type FieldTypeName,
  type FieldValueStorage,
  type RecordColumns,
} from './field-value-emptiness';

/**
 * Ticket #1308 — how many live records carry data for a field, counted from wherever that field's type STORES it (the one table is
 * `FIELD_VALUE_STORAGE`). This is the single counter behind `GET /fields/:field/usage` and delete-field's `records_with_value`.
 *
 * It is one aggregate query per field: counting by fetching a page of records and measuring it is the bug class the Tyron grounding rules
 * forbid ("counting must not be done by fetching"), and a page-sized answer to "is this field used" is worse than no answer.
 *
 * `complete` is the other half of "a report of 0 only ever means 0". It is false exactly when the caller cannot read the far side of a
 * relation this field is, or derives from: the count then covers only what they may see (the same narrowing a record query applies,
 * `relation-reach.ts`), so it can neither reveal that hidden links exist nor assert that none do. It says nothing about whether any exist.
 */
export interface FieldUsageCount {
  count: number;
  storage: FieldValueStorage;
  complete: boolean;
}

interface CountableField {
  id: string;
  databaseId: string;
  type: string;
  config: unknown;
}

const RECORD_ROW: RecordColumns = {
  values: records.values,
  computedValues: records.computedValues,
  title: records.title,
  number: records.number,
  createdBy: records.createdBy,
};

/** The same columns on the far record of a link, aliased `lk` in the subquery below. */
const FAR_ROW: RecordColumns = {
  values: sql.raw('lk."values"'),
  computedValues: sql.raw('lk."computed_values"'),
  title: sql.raw('lk."title"'),
  number: sql.raw('lk."number"'),
  createdBy: sql.raw('lk."created_by"'),
};

export async function countRecordsWithValue(
  deps: { db: Db; access: AccessService; fieldDefs: (databaseId: string) => Promise<FieldDef[]> },
  field: CountableField,
  membership?: Membership,
): Promise<FieldUsageCount> {
  const storage = FIELD_VALUE_STORAGE[field.type as FieldTypeName];
  if (storage === undefined) throw new Error(`field type "${field.type}" has no declared value storage`);
  const config = (field.config ?? {}) as Record<string, unknown>;
  const live = and(eq(records.databaseId, field.databaseId), isNull(records.deletedAt));
  const countWhere = async (predicate: SQL): Promise<number> => {
    const [row] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(records)
      .where(and(live, predicate));
    return row?.count ?? 0;
  };

  if (storage === 'none') return { count: 0, storage, complete: true };

  // Only a guest can read part of a relation's far side (same rule as the record query surface).
  const narrowed = membership?.role === 'guest' ? membership : undefined;

  if (storage === 'record_links' || storage === 'derived_from_links' || storage === 'computed_values') {
    const defs = narrowed ? await deps.fieldDefs(field.databaseId) : [];
    const reach = narrowed ? await relationFieldReach(deps.db, deps.access, narrowed, defs) : undefined;

    if (storage === 'computed_values') {
      const self = defs.find((d) => d.id === field.id);
      if (narrowed && reach && self && derivedFieldTaint(defs, new Map(defs.map((d) => [d.api_name, d])), reach)(self)) {
        return { count: 0, storage, complete: false };
      }
      const present = recordRowHasValueSql(storage, field.type, field.id, RECORD_ROW);
      return { count: await countWhere(present!), storage, complete: true };
    }

    // record_links (this field) and derived_from_links (a lookup, through the relation field it names) both walk a relation.
    const relationFieldId = storage === 'record_links' ? field.id : (config['relation_field_id'] as string | undefined);
    const relationField = relationFieldId
      ? await deps.db.query.fields.findFirst({
          where: and(eq(fields.id, relationFieldId), eq(fields.databaseId, field.databaseId), isNull(fields.deletedAt)),
        })
      : undefined;
    if (!relationField || relationField.type !== 'relation') return { count: 0, storage, complete: true }; // dangling: reads as no links
    const relationConfig = relationField.config as { relation_id?: string; side?: 'a' | 'b' };
    const relation = relationConfig.relation_id
      ? await deps.db.query.relations.findFirst({ where: eq(relations.id, relationConfig.relation_id) })
      : undefined;
    if (!relation) return { count: 0, storage, complete: true };
    const mine = relationConfig.side === 'b' ? 'to_record_id' : 'from_record_id';
    const far = relationConfig.side === 'b' ? 'from_record_id' : 'to_record_id';

    const reachHere: 'full' | 'none' | string[] = reach ? (reach.get(relationField.id) ?? 'none') : 'full';
    if (reachHere === 'none') return { count: 0, storage, complete: false };
    // A lookup's value is the far record's value, which a partly-readable far side would only show in part: it is held back like any
    // derived field (derivedFieldTaint), not counted over a subset.
    if (storage === 'derived_from_links' && reachHere !== 'full') return { count: 0, storage, complete: false };

    const visible = reachHere === 'full' ? sql`` : sql` AND rl.${sql.raw(far)} IN (${sql.join(reachHere.map((id) => sql`${id}`), sql`, `)})`;
    let farHasValue = sql``;
    if (storage === 'derived_from_links') {
      const targetApiName = config['target_field_api_name'];
      const farDatabaseId = relationConfig.side === 'b' ? relation.databaseAId : relation.databaseBId;
      const target =
        typeof targetApiName === 'string'
          ? await deps.db.query.fields.findFirst({
              where: and(eq(fields.databaseId, farDatabaseId), eq(fields.apiName, targetApiName), isNull(fields.deletedAt)),
            })
          : undefined;
      const targetPresent = target
        ? recordRowHasValueSql(FIELD_VALUE_STORAGE[target.type as FieldTypeName], target.type, target.id, FAR_ROW)
        : null;
      // A lookup of something that is not on the record row (a relation, a button) reads nothing; so does one whose target is gone.
      if (!targetPresent) return { count: 0, storage, complete: true };
      farHasValue = sql` AND ${targetPresent}`;
    }
    // A link to a TRASHED far record still counts: the row survives in the trash, restoring the record restores the link, and deleting
    // the relation would destroy it for good. (A record filter `not_empty` on a relation field agrees.) A deleted link is a deleted row.
    const link = sql`EXISTS (SELECT 1 FROM ${recordLinks} rl JOIN ${records} lk ON lk.id = rl.${sql.raw(far)} WHERE rl.relation_id = ${relation.id} AND rl.${sql.raw(mine)} = ${records.id}${visible}${farHasValue})`;
    return { count: await countWhere(link), storage, complete: reachHere === 'full' };
  }

  // On the record row itself: values, title, system columns.
  const cols: RecordColumns = narrowed ? { ...RECORD_ROW, title: sql`COALESCE(${records.titleLocal}, ${records.title})` } : RECORD_ROW;
  const present = recordRowHasValueSql(storage, field.type, field.id, cols);
  return { count: await countWhere(present!), storage, complete: true };
}
