import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, fields, recordLinks, records, relations } from '../db/schema';
import { DomainEventsService } from '../events/domain-events.service';
import { RelationsService } from './relations.service';
import type { StoredAutoLink } from './relations.service';
import {
  isComparableType,
  planAutoLinks,
  type AutoLinkConfig,
  type MatchRecord,
  type PlannedLink,
} from './auto-link';

/** Above this many records on the OTHER side, on-write auto-link is skipped (run-now still works). */
const ON_WRITE_MAX = 2000;

type Relation = typeof relations.$inferSelect;

/**
 * Auto-link execution/orchestration (MN-085), split out of RelationsService so the
 * hotspot service stays focused on relation + link CRUD. Owns both the run-now sweep
 * and the on-write per-record pass, plus their shared matching helpers.
 */
@Injectable()
export class AutoLinkService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly relations: RelationsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /** Resolve the stored config into typed match fields; null if unset or broken (deleted field). */
  private async resolveAutoLinkConfig(relation: Relation): Promise<AutoLinkConfig | null> {
    const raw = relation.autoLink as StoredAutoLink | null;
    if (!raw?.conditions?.length) return null;
    const ids = raw.conditions.flatMap((c) => [c.field_a_id, c.field_b_id]);
    const rows = await this.db.query.fields.findMany({
      where: and(inArray(fields.id, ids), isNull(fields.deletedAt)),
    });
    const byId = new Map(rows.map((f) => [f.id, f]));
    const conditions: AutoLinkConfig['conditions'] = [];
    for (const c of raw.conditions) {
      const fa = byId.get(c.field_a_id);
      const fb = byId.get(c.field_b_id);
      if (!fa || !fb || !isComparableType(fa.type) || !isComparableType(fb.type)) return null;
      conditions.push({ fieldA: { id: fa.id, type: fa.type }, fieldB: { id: fb.id, type: fb.type } });
    }
    return { conditions, caseSensitive: raw.case_sensitive ?? false };
  }

  private async loadMatchRecords(databaseId: string): Promise<MatchRecord[]> {
    const rows = await this.db.query.records.findMany({
      where: and(eq(records.databaseId, databaseId), isNull(records.deletedAt)),
      columns: { id: true, title: true, values: true },
    });
    return rows.map((r) => ({ id: r.id, title: r.title, values: (r.values ?? {}) as Record<string, unknown> }));
  }

  /** Existing links for a relation → per-A count + pair set, for dedup + one_to_many cap. */
  private async loadExistingLinks(relationId: string) {
    const links = await this.db.query.recordLinks.findMany({
      where: eq(recordLinks.relationId, relationId),
      columns: { fromRecordId: true, toRecordId: true },
    });
    const countByA = new Map<string, number>();
    const pairs = new Set<string>();
    for (const l of links) {
      countByA.set(l.fromRecordId, (countByA.get(l.fromRecordId) ?? 0) + 1);
      pairs.add(`${l.fromRecordId} ${l.toRecordId}`);
    }
    return { countByA, pairs };
  }

  private async insertPlannedLinks(
    workspaceId: string,
    relation: Relation,
    links: PlannedLink[],
    actorId: string | null,
  ): Promise<number> {
    if (!links.length) return 0;
    const titleByPair = new Map(links.map((l) => [`${l.fromId} ${l.toId}`, l]));
    let created = 0;
    // MN-287: every pair actually inserted (post onConflictDoNothing, across every
    // chunk) — carried out of the transaction so the record_linked emit below
    // follows the same after-commit convention RelationsService's addLinks uses.
    const insertedPairs: Array<{ fromRecordId: string; toRecordId: string }> = [];
    await this.db.transaction(async (tx) => {
      const CHUNK = 500;
      for (let i = 0; i < links.length; i += CHUNK) {
        const chunk = links.slice(i, i + CHUNK);
        const inserted = await tx
          .insert(recordLinks)
          .values(
            chunk.map((l) => ({ relationId: relation.id, fromRecordId: l.fromId, toRecordId: l.toId })),
          )
          .onConflictDoNothing()
          .returning({ fromRecordId: recordLinks.fromRecordId, toRecordId: recordLinks.toRecordId });
        created += inserted.length;
        insertedPairs.push(...inserted);
        const events = inserted.flatMap((row) => {
          const meta = titleByPair.get(`${row.fromRecordId} ${row.toRecordId}`);
          return [
            {
              workspaceId,
              recordId: row.fromRecordId,
              actorId,
              type: 'relation.linked' as const,
              payload: { relation_id: relation.id, other: { id: row.toRecordId, title: meta?.bTitle ?? '' }, auto: true },
            },
            {
              workspaceId,
              recordId: row.toRecordId,
              actorId,
              type: 'relation.linked' as const,
              payload: { relation_id: relation.id, other: { id: row.fromRecordId, title: meta?.aTitle ?? '' }, auto: true },
            },
          ];
        });
        if (events.length) await tx.insert(activityEvents).values(events);
      }
    });

    // MN-287: auto-link writes record_links directly, the same gap RelationsService's
    // dedicated Links API had before MN-267 wired addLinks/replaceLinks/removeLinks to
    // emit record_linked. Same event shape here, grouped by the side-A (fromRecordId)
    // record so one event's otherRecordIds covers every side-B target it was just
    // paired with — RollupInvalidationSubscriber's invalidateRollupsForChange walks
    // the relation's reverse field itself, so the side-B records' rollups are covered
    // without a second event.
    if (insertedPairs.length) {
      const otherIdsByFrom = new Map<string, string[]>();
      for (const { fromRecordId, toRecordId } of insertedPairs) {
        const list = otherIdsByFrom.get(fromRecordId);
        if (list) list.push(toRecordId);
        else otherIdsByFrom.set(fromRecordId, [toRecordId]);
      }
      for (const [fromRecordId, otherRecordIds] of otherIdsByFrom) {
        this.domainEvents.emit({
          type: 'record_linked',
          workspaceId,
          databaseId: relation.databaseAId,
          recordId: fromRecordId,
          relationFieldId: relation.fieldAId,
          actorId,
          depth: 0,
          linkedRelations: [
            {
              relationId: relation.id,
              fieldId: relation.fieldAId,
              otherDatabaseId: relation.databaseBId,
              otherRecordIds,
            },
          ],
        });
      }
    }
    return created;
  }

  /** Run auto-link across ALL existing records now. Returns a summary. */
  async runAutoLink(workspaceId: string, relationId: string, actorId: string) {
    const relation = await this.relations.getRelation(workspaceId, relationId);
    const config = await this.resolveAutoLinkConfig(relation);
    if (!config) {
      throw new UnprocessableEntityException('This relation has no valid auto-link rules configured');
    }
    const [aRecords, bRecords, existing] = await Promise.all([
      this.loadMatchRecords(relation.databaseAId),
      relation.databaseBId === relation.databaseAId
        ? Promise.resolve(null)
        : this.loadMatchRecords(relation.databaseBId),
      this.loadExistingLinks(relation.id),
    ]);
    const bList = bRecords ?? aRecords; // self-relation: same records on both sides
    const plan = planAutoLinks(
      aRecords,
      bList,
      config,
      relation.cardinality,
      existing.countByA,
      existing.pairs,
    );
    const created = await this.insertPlannedLinks(workspaceId, relation, plan.links, actorId);
    return {
      created,
      ambiguous: plan.ambiguous.length,
      unmatched: plan.unmatched,
      matched: plan.links.length,
    };
  }

  /**
   * Apply auto-link for a single record just written (MN-085 on-write). Best-effort:
   * for every auto-link relation this record's database participates in, match it
   * against the other side and create the resulting links. Skipped when the other
   * side is very large (protects write latency; the run-now button still works).
   */
  async autoLinkForRecord(
    databaseId: string,
    recordId: string,
    changedFieldIds: string[] | undefined,
    actorId: string | null,
  ): Promise<void> {
    const rels = await this.db.query.relations.findMany({
      where: and(
        or(eq(relations.databaseAId, databaseId), eq(relations.databaseBId, databaseId)),
        isNotNull(relations.autoLink),
      ),
    });
    for (const relation of rels) {
      const config = await this.resolveAutoLinkConfig(relation);
      if (!config) continue;

      // Which side(s) this database plays (both, for a self-relation).
      const sides: Array<'a' | 'b'> = [];
      if (relation.databaseAId === databaseId) sides.push('a');
      if (relation.databaseBId === databaseId) sides.push('b');

      for (const side of sides) {
        // On update, only bother if a match field on THIS side actually changed.
        if (changedFieldIds) {
          const fieldIds = config.conditions.map((c) => (side === 'a' ? c.fieldA.id : c.fieldB.id));
          if (!fieldIds.some((id) => changedFieldIds.includes(id))) continue;
        }

        const otherDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
        const otherCount = await this.db.$count(
          records,
          and(eq(records.databaseId, otherDbId), isNull(records.deletedAt)),
        );
        if (otherCount > ON_WRITE_MAX) continue;

        const [self] = await this.loadRecordsByIds(databaseId, [recordId]);
        if (!self) continue;
        const others = await this.loadMatchRecords(otherDbId);
        const existing = await this.loadExistingLinks(relation.id);

        // Place the changed record on its side; the other side is the full set.
        const [aRecords, bRecords] =
          side === 'a' ? [[self], others] : [others, [self]];
        const plan = planAutoLinks(
          aRecords,
          bRecords,
          config,
          relation.cardinality,
          existing.countByA,
          existing.pairs,
        );
        // Only links that actually touch the changed record.
        const mine = plan.links.filter((l) => l.fromId === recordId || l.toId === recordId);
        if (mine.length) await this.insertPlannedLinks(relation.workspaceId, relation, mine, actorId);
      }
    }
  }

  private async loadRecordsByIds(databaseId: string, ids: string[]): Promise<MatchRecord[]> {
    const rows = await this.db.query.records.findMany({
      where: and(eq(records.databaseId, databaseId), inArray(records.id, ids), isNull(records.deletedAt)),
      columns: { id: true, title: true, values: true },
    });
    return rows.map((r) => ({ id: r.id, title: r.title, values: (r.values ?? {}) as Record<string, unknown> }));
  }
}
