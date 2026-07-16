import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AutoLinkRules, RelationCardinality } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, fields, recordLinks, records, relations } from '../db/schema';
import { slugify } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import {
  isComparableType,
  planAutoLinks,
  type AutoLinkConfig,
  type MatchRecord,
  type PlannedLink,
} from './auto-link';

/** Persisted auto-link config (on relations.autoLink) — field ids, resolved at save. */
interface StoredAutoLink {
  conditions: Array<{ field_a_id: string; field_b_id: string }>;
  case_sensitive?: boolean;
}

/** Above this many records on the OTHER side, on-write auto-link is skipped (run-now still works). */
const ON_WRITE_MAX = 2000;

type Relation = typeof relations.$inferSelect;
type FieldRow = typeof fields.$inferSelect;

@Injectable()
export class RelationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async uniqueApiName(databaseId: string, displayName: string): Promise<string> {
    const root = slugify(displayName);
    const taken = new Set(
      (
        await this.db.query.fields.findMany({
          where: eq(fields.databaseId, databaseId),
          columns: { apiName: true },
        })
      ).map((f) => f.apiName),
    );
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Creates the relation + the paired relation-fields on both databases (B4). */
  async create(
    membership: Membership,
    input: {
      database_a_id: string;
      database_b_id: string;
      cardinality: RelationCardinality;
      field_a_name?: string;
      field_b_name?: string;
    },
  ) {
    const dbs = await this.db.query.databases.findMany({
      where: and(
        eq(databases.workspaceId, membership.workspaceId),
        inArray(databases.id, [input.database_a_id, input.database_b_id]),
      ),
    });
    const dbA = dbs.find((d) => d.id === input.database_a_id);
    const dbB = dbs.find((d) => d.id === input.database_b_id);
    if (!dbA || !dbB) throw new NotFoundException('Database not found');

    const selfRelation = dbA.id === dbB.id;

    // MN-211: a self-relation puts BOTH fields on one card — identical side names
    // would render two indistinguishable fields. Name them differently, e.g.
    // "Blocks" / "Blocked by". (The uniqueness guard below would catch it too, but
    // with a generic message; this one says what to actually do.)
    if (
      selfRelation &&
      input.field_a_name &&
      input.field_b_name &&
      input.field_a_name.trim().toLowerCase() === input.field_b_name.trim().toLowerCase()
    ) {
      throw new UnprocessableEntityException(
        'The two sides of a self-relation need different names — e.g. "Blocks" and "Blocked by"',
      );
    }

    /**
     * MN-212: display names must be unique per database. A USER-TYPED name that
     * collides is refused outright (never silently suffixed); an auto-generated
     * default (from the database names) suffixes itself to " 2", " 3", … instead.
     * `alsoTaken` carries side A's freshly-chosen name for the self-relation case,
     * where both new fields land on the same database.
     */
    const resolveDisplayName = async (
      databaseId: string,
      base: string,
      userTyped: boolean,
      alsoTaken: string[] = [],
    ): Promise<string> => {
      const existing = await this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
        columns: { displayName: true },
      });
      const taken = new Set([
        ...existing.map((f) => f.displayName.trim().toLowerCase()),
        ...alsoTaken.map((n) => n.trim().toLowerCase()),
      ]);
      const wanted = base.trim();
      if (!taken.has(wanted.toLowerCase())) return wanted;
      if (userTyped) {
        throw new UnprocessableEntityException(
          `A field named "${wanted}" already exists in this database`,
        );
      }
      for (let i = 2; ; i++) {
        const candidate = `${wanted} ${i}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
      }
    };

    // MN-211: self-relations are almost always hierarchy or dependency, so the
    // unnamed defaults say so — "Parent"/"Sub-items" for one_to_many (side A is
    // the many side: each record has at most one parent), "Related"/"Related to"
    // for many_to_many — instead of the old "<db>"/"<db> (inverse)" twins.
    const defaultA = selfRelation
      ? (input.cardinality === 'one_to_many' ? 'Parent' : 'Related')
      : dbB.name;
    const defaultB = selfRelation
      ? (input.cardinality === 'one_to_many' ? 'Sub-items' : 'Related to')
      : dbA.name;
    const fieldAName = await resolveDisplayName(
      dbA.id,
      input.field_a_name ?? defaultA,
      input.field_a_name !== undefined,
    );
    const fieldBName = await resolveDisplayName(
      dbB.id,
      input.field_b_name ?? defaultB,
      input.field_b_name !== undefined,
      selfRelation ? [fieldAName] : [],
    );

    const relationId = randomUUID();
    const fieldAId = randomUUID();
    const fieldBId = randomUUID();

    const apiNameA = await this.uniqueApiName(dbA.id, fieldAName);
    // For self-relations both fields live on the same database — reserve A's name first.
    const apiNameB = selfRelation
      ? await (async () => {
          const base = await this.uniqueApiName(dbB.id, fieldBName);
          return base === apiNameA ? `${base}_2` : base;
        })()
      : await this.uniqueApiName(dbB.id, fieldBName);

    const positionA = await this.nextPosition(dbA.id);
    const positionB = selfRelation ? positionA + 1 : await this.nextPosition(dbB.id);

    return this.db.transaction(async (tx) => {
      await tx.insert(fields).values([
        {
          id: fieldAId,
          databaseId: dbA.id,
          displayName: fieldAName,
          apiName: apiNameA,
          type: 'relation',
          config: { relation_id: relationId, side: 'a' },
          position: positionA,
        },
        {
          id: fieldBId,
          databaseId: dbB.id,
          displayName: fieldBName,
          apiName: apiNameB,
          type: 'relation',
          config: { relation_id: relationId, side: 'b' },
          position: positionB,
        },
      ]);
      const [relation] = await tx
        .insert(relations)
        .values({
          id: relationId,
          workspaceId: membership.workspaceId,
          databaseAId: dbA.id,
          databaseBId: dbB.id,
          fieldAId,
          fieldBId,
          cardinality: input.cardinality,
        })
        .returning();
      return {
        ...relation!,
        field_a: { id: fieldAId, database_id: dbA.id, display_name: fieldAName, api_name: apiNameA },
        field_b: { id: fieldBId, database_id: dbB.id, display_name: fieldBName, api_name: apiNameB },
      };
    });
  }

  private async nextPosition(databaseId: string): Promise<number> {
    const siblings = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), eq(fields.isSystem, false)),
      columns: { position: true },
    });
    return Math.max(0, ...siblings.map((f) => f.position)) + 1;
  }

  async getRelation(workspaceId: string, relationId: string): Promise<Relation> {
    const relation = await this.db.query.relations.findFirst({
      where: and(eq(relations.id, relationId), eq(relations.workspaceId, workspaceId)),
    });
    if (!relation) throw new NotFoundException('Relation not found');
    return relation;
  }

  /** Deletes the relation, BOTH fields, and every link (explicit confirm at DTO level). */
  async remove(workspaceId: string, relationId: string) {
    const relation = await this.getRelation(workspaceId, relationId);
    await this.db.transaction(async (tx) => {
      // Lookups (MN-040) and rollups (MN-064) through this relation lose their source — soft-delete them first.
      const lookups = await tx.query.fields.findMany({
        where: and(inArray(fields.type, ['lookup', 'rollup']), isNull(fields.deletedAt)),
      });
      const doomed = lookups
        .filter((l) => {
          const config = l.config as { relation_field_id?: string };
          return (
            config.relation_field_id === relation.fieldAId || config.relation_field_id === relation.fieldBId
          );
        })
        .map((l) => l.id);
      if (doomed.length) {
        await tx.update(fields).set({ deletedAt: new Date() }).where(inArray(fields.id, doomed));
      }
      await tx.delete(fields).where(inArray(fields.id, [relation.fieldAId, relation.fieldBId]));
      await tx.delete(relations).where(eq(relations.id, relationId)); // links cascade
    });
    return { deleted: true };
  }

  /** Raw relation row by id (importer + lookups). */
  async getById(relationId: string) {
    const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relationId) });
    if (!relation) throw new NotFoundException('Relation not found');
    return relation;
  }

  /** All relations touching a database (for introspection + delete guard). */
  async forDatabase(databaseId: string): Promise<Relation[]> {
    return this.db.query.relations.findMany({
      where: or(eq(relations.databaseAId, databaseId), eq(relations.databaseBId, databaseId)),
    });
  }

  // --- Auto-link (MN-085) ---

  /** Comparable-field picker rows for the auto-link rule editor. */
  private pickComparable(list: FieldRow[]) {
    return list
      .filter((f) => isComparableType(f.type))
      .map((f) => ({ id: f.id, api_name: f.apiName, display_name: f.displayName, type: f.type }));
  }

  /** Relation + both sides' fields + auto-link config, for the config UI. */
  async getRelationDetail(workspaceId: string, relationId: string) {
    const relation = await this.getRelation(workspaceId, relationId);
    const [fieldsA, fieldsB] = await Promise.all([
      this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, relation.databaseAId), isNull(fields.deletedAt)),
      }),
      relation.databaseBId === relation.databaseAId
        ? Promise.resolve([] as FieldRow[])
        : this.db.query.fields.findMany({
            where: and(eq(fields.databaseId, relation.databaseBId), isNull(fields.deletedAt)),
          }),
    ]);
    const listA = fieldsA;
    const listB = relation.databaseBId === relation.databaseAId ? fieldsA : fieldsB;
    const fieldA = listA.find((f) => f.id === relation.fieldAId);
    const fieldB = listB.find((f) => f.id === relation.fieldBId);
    return {
      id: relation.id,
      cardinality: relation.cardinality,
      database_a_id: relation.databaseAId,
      database_b_id: relation.databaseBId,
      field_a: fieldA
        ? { id: fieldA.id, api_name: fieldA.apiName, display_name: fieldA.displayName }
        : null,
      field_b: fieldB
        ? { id: fieldB.id, api_name: fieldB.apiName, display_name: fieldB.displayName }
        : null,
      auto_link: (relation.autoLink as StoredAutoLink | null) ?? null,
      comparable_fields_a: this.pickComparable(listA),
      comparable_fields_b: this.pickComparable(listB),
    };
  }

  /** Set (or clear, with null) a relation's auto-link rules. Resolves + validates fields. */
  async setAutoLink(workspaceId: string, relationId: string, rules: AutoLinkRules | null) {
    const relation = await this.getRelation(workspaceId, relationId);
    if (rules === null) {
      await this.db.update(relations).set({ autoLink: null }).where(eq(relations.id, relationId));
      return this.getRelationDetail(workspaceId, relationId);
    }
    const [fieldsA, fieldsB] = await Promise.all([
      this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, relation.databaseAId), isNull(fields.deletedAt)),
      }),
      relation.databaseBId === relation.databaseAId
        ? Promise.resolve([] as FieldRow[])
        : this.db.query.fields.findMany({
            where: and(eq(fields.databaseId, relation.databaseBId), isNull(fields.deletedAt)),
          }),
    ]);
    const listA = fieldsA;
    const listB = relation.databaseBId === relation.databaseAId ? fieldsA : fieldsB;

    const resolve = (list: FieldRow[], ref: string, sideLabel: string): string => {
      const f = list.find((x) => x.id === ref || x.apiName === ref);
      if (!f) throw new UnprocessableEntityException(`No field "${ref}" on the ${sideLabel} database`);
      if (!isComparableType(f.type)) {
        throw new UnprocessableEntityException(
          `Field "${f.displayName}" (${f.type}) can't be matched — auto-link supports title, text, url, email, number and date fields`,
        );
      }
      return f.id;
    };

    const stored: StoredAutoLink = {
      conditions: rules.conditions.map((c) => ({
        field_a_id: resolve(listA, c.field_a, 'first'),
        field_b_id: resolve(listB, c.field_b, 'second'),
      })),
      case_sensitive: rules.case_sensitive,
    };
    await this.db.update(relations).set({ autoLink: stored }).where(eq(relations.id, relationId));
    return this.getRelationDetail(workspaceId, relationId);
  }

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
    actorId: string,
  ): Promise<number> {
    if (!links.length) return 0;
    const titleByPair = new Map(links.map((l) => [`${l.fromId} ${l.toId}`, l]));
    let created = 0;
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
    return created;
  }

  /** Run auto-link across ALL existing records now. Returns a summary. */
  async runAutoLink(workspaceId: string, relationId: string, actorId: string) {
    const relation = await this.getRelation(workspaceId, relationId);
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
    actorId: string,
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

  // --- Links ---

  private async resolveLinkContext(databaseId: string, recordId: string, fieldId: string) {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, fieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    if (!field || field.type !== 'relation') throw new NotFoundException('Relation field not found');
    const config = field.config as { relation_id: string; side: 'a' | 'b' };
    const relation = await this.db.query.relations.findFirst({
      where: eq(relations.id, config.relation_id),
    });
    if (!relation) throw new NotFoundException('Relation not found');

    const record = await this.db.query.records.findFirst({
      where: and(eq(records.id, recordId), eq(records.databaseId, databaseId), isNull(records.deletedAt)),
    });
    if (!record) throw new NotFoundException('Record not found');

    const side = config.side;
    const targetDatabaseId = side === 'a' ? relation.databaseBId : relation.databaseAId;
    return { field, relation, record, side, targetDatabaseId };
  }

  async listLinks(databaseId: string, recordId: string, fieldId: string) {
    const { relation, side } = await this.resolveLinkContext(databaseId, recordId, fieldId);
    const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

    const rows = await this.db
      .select({ id: records.id, title: records.title, number: records.number })
      .from(recordLinks)
      .innerJoin(records, eq(records.id, otherCol))
      .where(
        and(eq(recordLinks.relationId, relation.id), eq(myCol, recordId), isNull(records.deletedAt)),
      )
      .orderBy(asc(records.title))
      .limit(200);
    return { data: rows };
  }

  private async writeLinkEvents(
    tx: Db,
    workspaceId: string,
    actorId: string,
    type: 'relation.linked' | 'relation.unlinked',
    relation: Relation,
    record: { id: string; title: string },
    targets: Array<{ id: string; title: string }>,
  ) {
    const events = targets.flatMap((target) => [
      {
        workspaceId,
        recordId: record.id,
        actorId,
        type,
        payload: { relation_id: relation.id, other: target },
      },
      {
        workspaceId,
        recordId: target.id,
        actorId,
        type,
        payload: { relation_id: relation.id, other: { id: record.id, title: record.title } },
      },
    ]);
    if (events.length) await tx.insert(activityEvents).values(events);
  }

  private async loadTargets(targetDatabaseId: string, ids: string[]) {
    const targets = await this.db.query.records.findMany({
      where: and(
        inArray(records.id, ids),
        eq(records.databaseId, targetDatabaseId),
        isNull(records.deletedAt),
      ),
      columns: { id: true, title: true },
    });
    if (targets.length !== new Set(ids).size) {
      throw new UnprocessableEntityException('One or more target records were not found');
    }
    return targets;
  }

  async addLinks(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    fieldId: string,
    targetIds: string[],
    actorId: string,
  ) {
    const ctx = await this.resolveLinkContext(databaseId, recordId, fieldId);
    const targets = await this.loadTargets(ctx.targetDatabaseId, targetIds);

    if (ctx.relation.cardinality === 'one_to_many' && ctx.side === 'a') {
      const existing = await this.db.query.recordLinks.findMany({
        where: and(eq(recordLinks.relationId, ctx.relation.id), eq(recordLinks.fromRecordId, recordId)),
      });
      if (existing.length + targets.length > 1) {
        throw new ConflictException(
          'This record can link to only one target (one-to-many). Use replace instead.',
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(recordLinks)
        .values(
          targets.map((t) => ({
            relationId: ctx.relation.id,
            fromRecordId: ctx.side === 'a' ? recordId : t.id,
            toRecordId: ctx.side === 'a' ? t.id : recordId,
          })),
        )
        .onConflictDoNothing();
      await this.writeLinkEvents(
        tx as unknown as Db,
        workspaceId,
        actorId,
        'relation.linked',
        ctx.relation,
        { id: ctx.record.id, title: ctx.record.title },
        targets,
      );
    });
    return this.listLinks(databaseId, recordId, fieldId);
  }

  async replaceLinks(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    fieldId: string,
    targetIds: string[],
    actorId: string,
  ) {
    const ctx = await this.resolveLinkContext(databaseId, recordId, fieldId);
    if (ctx.relation.cardinality === 'one_to_many' && ctx.side === 'a' && targetIds.length > 1) {
      throw new ConflictException('This record can link to only one target (one-to-many)');
    }
    const targets = targetIds.length ? await this.loadTargets(ctx.targetDatabaseId, targetIds) : [];
    const myCol = ctx.side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;

    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(recordLinks)
        .where(and(eq(recordLinks.relationId, ctx.relation.id), eq(myCol, recordId)))
        .returning();
      if (removed.length) {
        const removedIds = removed.map((l) => (ctx.side === 'a' ? l.toRecordId : l.fromRecordId));
        const removedTargets = await tx.query.records.findMany({
          where: inArray(records.id, removedIds),
          columns: { id: true, title: true },
        });
        await this.writeLinkEvents(
          tx as unknown as Db,
          workspaceId,
          actorId,
          'relation.unlinked',
          ctx.relation,
          { id: ctx.record.id, title: ctx.record.title },
          removedTargets,
        );
      }
      if (targets.length) {
        await tx.insert(recordLinks).values(
          targets.map((t) => ({
            relationId: ctx.relation.id,
            fromRecordId: ctx.side === 'a' ? recordId : t.id,
            toRecordId: ctx.side === 'a' ? t.id : recordId,
          })),
        );
        await this.writeLinkEvents(
          tx as unknown as Db,
          workspaceId,
          actorId,
          'relation.linked',
          ctx.relation,
          { id: ctx.record.id, title: ctx.record.title },
          targets,
        );
      }
    });
    return this.listLinks(databaseId, recordId, fieldId);
  }

  async removeLinks(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    fieldId: string,
    targetIds: string[],
    actorId: string,
  ) {
    const ctx = await this.resolveLinkContext(databaseId, recordId, fieldId);
    const myCol = ctx.side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const otherCol = ctx.side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(recordLinks)
        .where(
          and(
            eq(recordLinks.relationId, ctx.relation.id),
            eq(myCol, recordId),
            inArray(otherCol, targetIds),
          ),
        )
        .returning();
      if (removed.length) {
        const removedIds = removed.map((l) => (ctx.side === 'a' ? l.toRecordId : l.fromRecordId));
        const removedTargets = await tx.query.records.findMany({
          where: inArray(records.id, removedIds),
          columns: { id: true, title: true },
        });
        await this.writeLinkEvents(
          tx as unknown as Db,
          workspaceId,
          actorId,
          'relation.unlinked',
          ctx.relation,
          { id: ctx.record.id, title: ctx.record.title },
          removedTargets,
        );
      }
    });
    return this.listLinks(databaseId, recordId, fieldId);
  }
}

export type { FieldRow };
