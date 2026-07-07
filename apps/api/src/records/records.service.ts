import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql, SQL } from 'drizzle-orm';
import { validateRecordValues } from '@storyos/schemas';
import type { FieldDef } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, fields, recordLinks, records, selectOptions } from '../db/schema';
import type { QueryRecordsInput } from '@storyos/schemas';
import { compileFilter, cursorCondition, sortExpr } from './query-compiler';
import type { SortSpec } from './query-compiler';
import { keyBetween, keysAfter } from './rank';

type RecordRow = typeof records.$inferSelect;

export interface ProjectedRecord {
  id: string;
  title: string;
  values: Record<string, unknown>;
  position: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const TRASH_RETENTION_DAYS = 30;

/**
 * The RecordsRepository seam (ADR-0002): every record read/write in the
 * system flows through this service. Storage strategy changes happen here,
 * behind an unchanged public API.
 */
@Injectable()
export class RecordsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Live field definitions + valid option ids, in validator shape. */
  async fieldDefs(databaseId: string): Promise<FieldDef[]> {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const selectFieldIds = fieldRows
      .filter((f) => f.type === 'select' || f.type === 'multi_select')
      .map((f) => f.id);
    const options = selectFieldIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectFieldIds),
        })
      : [];
    const optionsByField = new Map<string, string[]>();
    for (const option of options) {
      const list = optionsByField.get(option.fieldId) ?? [];
      list.push(option.id);
      optionsByField.set(option.fieldId, list);
    }
    return fieldRows.map((f) => ({
      id: f.id,
      api_name: f.apiName,
      type: f.type,
      config: (f.config ?? {}) as Record<string, unknown>,
      option_ids: optionsByField.get(f.id),
    }));
  }

  /** Projects storage rows through live fields: api_name keys, dangling options → null. */
  project(row: RecordRow, defs: FieldDef[]): ProjectedRecord {
    const values: Record<string, unknown> = {};
    const stored = row.values as Record<string, unknown>;
    for (const def of defs) {
      if (def.type === 'title' || def.type === 'relation') continue;
      if (def.type === 'created_at' || def.type === 'updated_at' || def.type === 'created_by') continue;
      const raw = stored[def.id];
      if (raw === undefined || raw === null) continue;
      if (def.type === 'select') {
        values[def.api_name] = def.option_ids?.includes(raw as string) ? raw : null;
      } else if (def.type === 'multi_select') {
        const kept = (raw as string[]).filter((id) => def.option_ids?.includes(id));
        if (kept.length) values[def.api_name] = kept;
      } else {
        values[def.api_name] = raw;
      }
    }
    return {
      id: row.id,
      title: row.title,
      values,
      position: row.position,
      created_by: row.createdBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  /** Fills relation-field values with {id, title} chips for a page of records (MN-018). */
  async attachLinks(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const relationDefs = defs.filter((d) => d.type === 'relation');
    if (relationDefs.length === 0 || projected.length === 0) return projected;
    const ids = projected.map((p) => p.id);

    for (const def of relationDefs) {
      const relationId = def.config['relation_id'] as string;
      const side = def.config['side'] as 'a' | 'b';
      const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
      const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

      const rows = await this.db
        .select({ mine: myCol, id: records.id, title: records.title })
        .from(recordLinks)
        .innerJoin(records, eq(records.id, otherCol))
        .where(
          and(
            eq(recordLinks.relationId, relationId),
            inArray(myCol, ids),
            isNull(records.deletedAt),
          ),
        );

      const byRecord = new Map<string, Array<{ id: string; title: string }>>();
      for (const row of rows) {
        const list = byRecord.get(row.mine) ?? [];
        list.push({ id: row.id, title: row.title });
        byRecord.set(row.mine, list);
      }
      for (const record of projected) {
        const chips = byRecord.get(record.id);
        if (chips?.length) record.values[def.api_name] = chips;
      }
    }
    return projected;
  }

  private validateOrThrow(defs: FieldDef[], input: Record<string, unknown>) {
    const result = validateRecordValues(defs, input);
    if (result.issues.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Record values validation failed',
        details: result.issues,
      });
    }
    return result;
  }

  private async lastPosition(databaseId: string): Promise<string | null> {
    const [last] = await this.db
      .select({ position: records.position })
      .from(records)
      .where(eq(records.databaseId, databaseId))
      .orderBy(desc(records.position))
      .limit(1);
    return last?.position ?? null;
  }

  async create(
    workspaceId: string,
    databaseId: string,
    input: Record<string, unknown>,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const [created] = await this.createBatch(workspaceId, databaseId, [input], actorId);
    return created!;
  }

  /** Batch create (≤100, enforced by the DTO), one transaction, one activity event each. */
  async createBatch(
    workspaceId: string,
    databaseId: string,
    inputs: Array<Record<string, unknown>>,
    actorId: string,
  ): Promise<ProjectedRecord[]> {
    const defs = await this.fieldDefs(databaseId);
    const validated = inputs.map((input) => this.validateOrThrow(defs, input));
    const positions = await keysAfter(await this.lastPosition(databaseId), inputs.length);

    const rows = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(records)
        .values(
          validated.map((v, i) => ({
            databaseId,
            title: v.title ?? '',
            values: stripNulls(v.values),
            position: positions[i]!,
            createdBy: actorId,
            updatedBy: actorId,
          })),
        )
        .returning();
      await tx.insert(activityEvents).values(
        inserted.map((row) => ({
          workspaceId,
          recordId: row.id,
          actorId,
          type: 'record.created',
          payload: { title: row.title },
        })),
      );
      return inserted;
    });
    return rows.map((row) => this.project(row, defs));
  }

  async getRow(databaseId: string, recordId: string): Promise<RecordRow> {
    const row = await this.db.query.records.findFirst({
      where: and(eq(records.id, recordId), eq(records.databaseId, databaseId), isNull(records.deletedAt)),
    });
    if (!row) throw new NotFoundException('Record not found');
    return row;
  }

  async get(databaseId: string, recordId: string): Promise<ProjectedRecord> {
    const [row, defs] = await Promise.all([
      this.getRow(databaseId, recordId),
      this.fieldDefs(databaseId),
    ]);
    const [projected] = await this.attachLinks([this.project(row, defs)], defs);
    return projected!;
  }

  async update(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    input: Record<string, unknown>,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const defs = await this.fieldDefs(databaseId);
    const row = await this.getRow(databaseId, recordId);
    const validated = this.validateOrThrow(defs, input);

    const before = row.values as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...before };
    const diff: Record<string, { from: unknown; to: unknown }> = {};

    for (const [fieldId, value] of Object.entries(validated.values)) {
      const previous = before[fieldId] ?? null;
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      diff[fieldId] = { from: previous, to: value };
      if (value === null) delete merged[fieldId];
      else merged[fieldId] = value;
    }
    if (validated.title !== undefined && validated.title !== row.title) {
      diff['title'] = { from: row.title, to: validated.title };
    }

    if (Object.keys(diff).length === 0) return this.project(row, defs);

    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(records)
        .set({ values: merged, title: validated.title ?? row.title, updatedBy: actorId })
        .where(eq(records.id, recordId))
        .returning();
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.updated',
        payload: { diff },
      });
      return next!;
    });
    return this.project(updated, defs);
  }

  /**
   * Atomic move (ADR-0005 / MN-022): new fractional position between the given
   * neighbor and its adjacent record, plus an optional value patch (kanban
   * drops change group field + position in ONE call). Position changes emit
   * no activity noise; value changes reuse the normal update path.
   */
  async move(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    input: { before_record_id?: string; after_record_id?: string; values?: Record<string, unknown> },
    actorId: string,
  ): Promise<ProjectedRecord> {
    await this.getRow(databaseId, recordId);

    let newPosition: string | undefined;
    if (input.before_record_id || input.after_record_id) {
      const anchorId = (input.before_record_id ?? input.after_record_id)!;
      const anchor = await this.getRow(databaseId, anchorId);

      if (input.after_record_id) {
        // Place directly after the anchor: between anchor and its successor.
        const [next] = await this.db
          .select({ position: records.position })
          .from(records)
          .where(
            and(
              eq(records.databaseId, databaseId),
              isNull(records.deletedAt),
              sql`(${records.position}, ${records.id}) > (${anchor.position}, ${anchor.id})`,
            ),
          )
          .orderBy(asc(records.position), asc(records.id))
          .limit(1);
        newPosition = await keyBetween(anchor.position, next?.position ?? null);
      } else {
        // Place directly before the anchor: between its predecessor and anchor.
        const [prev] = await this.db
          .select({ position: records.position })
          .from(records)
          .where(
            and(
              eq(records.databaseId, databaseId),
              isNull(records.deletedAt),
              sql`(${records.position}, ${records.id}) < (${anchor.position}, ${anchor.id})`,
            ),
          )
          .orderBy(desc(records.position), desc(records.id))
          .limit(1);
        newPosition = await keyBetween(prev?.position ?? null, anchor.position);
      }
    }

    if (newPosition !== undefined) {
      await this.db.update(records).set({ position: newPosition }).where(eq(records.id, recordId));
      // Rebalance fallback: fractional keys grow on repeated same-gap inserts.
      if (newPosition.length > 40) await this.rebalance(databaseId);
    }

    if (input.values && Object.keys(input.values).length > 0) {
      return this.update(workspaceId, databaseId, recordId, input.values, actorId);
    }
    return this.get(databaseId, recordId);
  }

  /** Rewrites all positions with fresh evenly-spaced keys (key-length exhaustion). */
  private async rebalance(databaseId: string) {
    const rows = await this.db.query.records.findMany({
      where: eq(records.databaseId, databaseId),
      orderBy: [asc(records.position), asc(records.id)],
      columns: { id: true },
    });
    const keys = await keysAfter(null, rows.length);
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        await tx.update(records).set({ position: keys[i]! }).where(eq(records.id, rows[i]!.id));
      }
    });
  }

  async softDelete(workspaceId: string, databaseId: string, recordId: string, actorId: string) {
    await this.getRow(databaseId, recordId);
    await this.db.transaction(async (tx) => {
      await tx.update(records).set({ deletedAt: new Date() }).where(eq(records.id, recordId));
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.deleted',
        payload: {},
      });
    });
    return { deleted: true };
  }

  async restore(workspaceId: string, databaseId: string, recordId: string, actorId: string) {
    const row = await this.db.query.records.findFirst({
      where: and(
        eq(records.id, recordId),
        eq(records.databaseId, databaseId),
        isNotNull(records.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException('Record not found in trash');
    await this.db.transaction(async (tx) => {
      await tx.update(records).set({ deletedAt: null }).where(eq(records.id, recordId));
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.restored',
        payload: {},
      });
    });
    const defs = await this.fieldDefs(databaseId);
    return this.project({ ...row, deletedAt: null }, defs);
  }

  async listTrash(databaseId: string) {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.db.query.records.findMany({
      where: and(
        eq(records.databaseId, databaseId),
        isNotNull(records.deletedAt),
        gt(records.deletedAt, cutoff),
      ),
      orderBy: [desc(records.deletedAt)],
      limit: 200,
    });
    return rows.map((r) => ({ id: r.id, title: r.title, deleted_at: r.deletedAt }));
  }

  /**
   * The workhorse: POST /records/query (MN-012). Filter AST → SQL via the
   * compiler; multi-key sorts with NULLS LAST; keyset cursors with id
   * tiebreaker; no sorts = manual (position) order.
   */
  async query(databaseId: string, input: QueryRecordsInput, currentUserId: string) {
    const defs = await this.fieldDefs(databaseId);
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));

    const SORTABLE = new Set([
      'title', 'text', 'number', 'date', 'url', 'email', 'select',
      'checkbox', 'created_at', 'updated_at', 'created_by', 'user',
    ]);
    const sorts: SortSpec[] = input.sorts.map((s) => {
      const def = byApiName.get(s.field);
      if (!def) throw new UnprocessableEntityException(`unknown sort field "${s.field}"`);
      if (!SORTABLE.has(def.type) || (def.type === 'user' && def.config['multi'] === true)) {
        throw new UnprocessableEntityException(`cannot sort by ${def.type} field "${s.field}"`);
      }
      return { def, direction: s.direction };
    });

    const conditions: unknown[] = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
    if (input.q) conditions.push(sql`${records.title} ILIKE ${'%' + input.q + '%'}`);
    if (input.filter) {
      conditions.push(compileFilter(input.filter, { defs: byApiName, currentUserId }));
    }

    if (input.cursor) {
      const decoded = decodeQueryCursor(input.cursor, sorts.length);
      if (sorts.length > 0) {
        conditions.push(
          cursorCondition(
            sorts,
            (decoded.v ?? []).map((value, i) => reviveSortValue(value, sorts[i]!.def.type)),
            decoded.id,
          ),
        );
      } else {
        const after = or(
          gt(records.position, String(decoded.p)),
          and(eq(records.position, String(decoded.p)), gt(records.id, decoded.id)),
        );
        conditions.push(after!);
      }
    }

    const orderBy =
      sorts.length > 0
        ? [
            ...sorts.map((s) =>
              s.direction === 'asc'
                ? sql`${sortExpr(s.def)} ASC NULLS LAST`
                : sql`${sortExpr(s.def)} DESC NULLS LAST`,
            ),
            asc(records.id),
          ]
        : [asc(records.position), asc(records.id)];

    const rows = await this.db
      .select()
      .from(records)
      .where(and(...(conditions as Parameters<typeof and>)))
      .orderBy(...(orderBy as SQL[]))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = page[page.length - 1];

    let nextCursor: string | null = null;
    if (hasMore && last) {
      nextCursor =
        sorts.length > 0
          ? encodeQueryCursor({ v: sorts.map((s) => extractSortValue(last, s.def)), id: last.id })
          : encodeQueryCursor({ p: last.position, id: last.id });
    }

    return {
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  /** Simple list: manual (position) order, optional q title search, keyset cursor. */
  async list(databaseId: string, opts: { limit: number; cursor?: string; q?: string }) {
    const defs = await this.fieldDefs(databaseId);
    const conditions = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
    if (opts.q) conditions.push(sql`${records.title} ILIKE ${'%' + opts.q + '%'}`);

    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      const after = or(
        gt(records.position, decoded.position),
        and(eq(records.position, decoded.position), gt(records.id, decoded.id)),
      );
      conditions.push(after!);
    }

    const rows = await this.db.query.records.findMany({
      where: and(...conditions),
      orderBy: [asc(records.position), asc(records.id)],
      limit: opts.limit + 1,
    });

    const page = rows.slice(0, opts.limit);
    const hasMore = rows.length > opts.limit;
    const lastRow = page[page.length - 1];
    return {
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs),
      next_cursor: hasMore && lastRow ? encodeCursor(lastRow.position, lastRow.id) : null,
      has_more: hasMore,
    };
  }
}

function stripNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
}

function extractSortValue(row: RecordRow, def: { id: string; type: string }): unknown {
  if (def.type === 'title') return row.title;
  if (def.type === 'created_at') return row.createdAt.toISOString();
  if (def.type === 'updated_at') return row.updatedAt.toISOString();
  if (def.type === 'created_by') return row.createdBy;
  const raw = (row.values as Record<string, unknown>)[def.id];
  return raw === undefined ? null : raw;
}

function reviveSortValue(value: unknown, type: string): unknown {
  if (value === null) return null;
  if (type === 'created_at' || type === 'updated_at') return new Date(String(value));
  return value;
}

interface QueryCursor {
  v?: unknown[];
  p?: string;
  id: string;
}

function encodeQueryCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeQueryCursor(cursor: string, expectedSortCount: number): Required<Pick<QueryCursor, 'id'>> & QueryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as QueryCursor;
    if (typeof parsed.id !== 'string') throw new Error();
    if (expectedSortCount > 0) {
      if (!Array.isArray(parsed.v) || parsed.v.length !== expectedSortCount) throw new Error();
    } else if (typeof parsed.p !== 'string') {
      throw new Error();
    }
    return parsed as Required<Pick<QueryCursor, 'id'>> & QueryCursor;
  } catch {
    throw new UnprocessableEntityException('Invalid cursor');
  }
}

function encodeCursor(position: string, id: string): string {
  return Buffer.from(JSON.stringify({ position, id })).toString('base64url');
}

function decodeCursor(cursor: string): { position: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      position: string;
      id: string;
    };
    if (typeof parsed.position !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return parsed;
  } catch {
    throw new UnprocessableEntityException('Invalid cursor');
  }
}
