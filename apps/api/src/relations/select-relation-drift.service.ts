import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, recordLinks, selectOptions } from '../db/schema';
import { RelationsService } from './relations.service';
import { findDriftPairing, missingLinks } from './select-relation-drift';

const CANDIDATE_CAP = 500; // matches the scan cap used elsewhere for a single reconcile pass
const PREVIEW_CAP = 20; // how many missing records the check response previews

export interface SelectDriftResult {
  select_field: { id: string; api_name: string; display_name: string };
  matched_option: { id: string; label: string };
  missing_count: number;
  missing_records: Array<{ id: string; title: string; number: number | null }>;
}

/**
 * Select↔relation drift check + bulk-link reconciliation (MN-286), split out
 * of RelationsService (a hotspot file) the same way auto-link's orchestration
 * is — this only ever calls RelationsService's existing public methods
 * (getRelation, addLinks), never edits it.
 */
@Injectable()
export class SelectRelationDriftService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly relations: RelationsService,
  ) {}

  /**
   * Resolve which side of the relation `parentRecordId` sits on, and compute
   * the full (uncapped) set of child records that carry a select label
   * matching the parent's title but aren't linked via this relation. Returns
   * null when there's no drift (or no plausible select↔relation pairing at
   * all) — the common case, so callers can render nothing.
   */
  private async computeFullDrift(workspaceId: string, relationId: string, parentRecordId: string) {
    const relation = await this.relations.getRelation(workspaceId, relationId);
    // Self-relations (hierarchy/dependency, e.g. "Blocks"/"Blocked by") don't fit this
    // shape — side and "the child database's select fields" are ill-defined when both
    // sides are the same database. Out of scope for this check.
    if (relation.databaseAId === relation.databaseBId) return null;

    const parent = await this.db.query.records.findFirst({
      where: and(eq(records.id, parentRecordId), isNull(records.deletedAt)),
      columns: { id: true, title: true, databaseId: true },
    });
    if (!parent) throw new NotFoundException('Record not found');

    let parentSide: 'a' | 'b';
    if (parent.databaseId === relation.databaseAId) parentSide = 'a';
    else if (parent.databaseId === relation.databaseBId) parentSide = 'b';
    else throw new NotFoundException('Record does not belong to either side of this relation');

    const childDatabaseId = parentSide === 'a' ? relation.databaseBId : relation.databaseAId;
    const childFieldId = parentSide === 'a' ? relation.fieldBId : relation.fieldAId;

    const childSelectFields = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, childDatabaseId), eq(fields.type, 'select'), isNull(fields.deletedAt)),
      columns: { id: true, apiName: true, displayName: true },
    });
    if (!childSelectFields.length) return null;

    const options = await this.db.query.selectOptions.findMany({
      where: inArray(
        selectOptions.fieldId,
        childSelectFields.map((f) => f.id),
      ),
      columns: { id: true, fieldId: true, label: true },
    });

    const pairing = findDriftPairing(childSelectFields, options, parent.title);
    if (!pairing) return null;

    const candidates = await this.db
      .select({ id: records.id, title: records.title, number: records.number })
      .from(records)
      .where(
        and(
          eq(records.databaseId, childDatabaseId),
          isNull(records.deletedAt),
          sql`(${records.values} ->> ${pairing.field.id}) = ${pairing.option.id}`,
        ),
      )
      .limit(CANDIDATE_CAP);
    if (!candidates.length) return null;

    // Child ids already linked to THIS parent through the relation.
    const parentCol = parentSide === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const childCol = parentSide === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
    const linkedRows = await this.db
      .select({ id: childCol })
      .from(recordLinks)
      .where(and(eq(recordLinks.relationId, relation.id), eq(parentCol, parentRecordId)));
    const linkedChildIds = new Set(linkedRows.map((r) => r.id));

    const missing = missingLinks(candidates, linkedChildIds);
    if (!missing.length) return null;

    return { relation, parentSide, childDatabaseId, childFieldId, pairing, missing };
  }

  /** Controller-facing check: same computation, previewed/capped for the banner UI. */
  async checkDrift(
    workspaceId: string,
    relationId: string,
    parentRecordId: string,
  ): Promise<{ drift: SelectDriftResult | null }> {
    const full = await this.computeFullDrift(workspaceId, relationId, parentRecordId);
    if (!full) return { drift: null };
    return {
      drift: {
        select_field: {
          id: full.pairing.field.id,
          api_name: full.pairing.field.apiName,
          display_name: full.pairing.field.displayName,
        },
        matched_option: full.pairing.option,
        missing_count: full.missing.length,
        missing_records: full.missing.slice(0, PREVIEW_CAP),
      },
    };
  }

  /**
   * Link every currently-drifted child record to the parent. Recomputes the
   * drift server-side rather than trusting a client-supplied id list, so a
   * stale banner can never link the wrong records. Reuses
   * RelationsService.addLinks per record — respects cardinality, writes the
   * same activity events as a manual link, and reports (not throws) on any
   * per-record conflict instead of failing the whole batch.
   */
  async reconcile(workspaceId: string, relationId: string, parentRecordId: string, actorId: string) {
    const full = await this.computeFullDrift(workspaceId, relationId, parentRecordId);
    if (!full) return { linked: 0, failed: [] as Array<{ record_id: string; message: string }> };

    const failed: Array<{ record_id: string; message: string }> = [];
    let linked = 0;
    for (const child of full.missing) {
      try {
        await this.relations.addLinks(
          workspaceId,
          full.childDatabaseId,
          child.id,
          full.childFieldId,
          [parentRecordId],
          actorId,
        );
        linked++;
      } catch (error) {
        failed.push({
          record_id: child.id,
          message: error instanceof Error ? error.message : 'Could not link this record',
        });
      }
    }
    return { linked, failed };
  }
}
