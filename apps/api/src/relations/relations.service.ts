import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RelationCardinality } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, fields, recordLinks, records, relations } from '../db/schema';
import { slugify } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';

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
    const fieldAName = input.field_a_name ?? dbB.name;
    const fieldBName = input.field_b_name ?? (selfRelation ? `${dbA.name} (inverse)` : dbA.name);

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
      // Lookups through this relation lose their source (MN-040) — soft-delete them first.
      const lookups = await tx.query.fields.findMany({
        where: and(eq(fields.type, 'lookup'), isNull(fields.deletedAt)),
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
      .select({ id: records.id, title: records.title })
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
