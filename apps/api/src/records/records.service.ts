import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { validateRecordValues } from '@storyos/schemas';
import type { FieldDef } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, fields, records, selectOptions } from '../db/schema';
import { keysAfter } from './rank';

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
    return this.project(row, defs);
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
      data: page.map((r) => this.project(r, defs)),
      next_cursor: hasMore && lastRow ? encodeCursor(lastRow.position, lastRow.id) : null,
      has_more: hasMore,
    };
  }
}

function stripNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
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
