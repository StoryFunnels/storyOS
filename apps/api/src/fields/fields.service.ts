import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { CreatableFieldType } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, selectOptions } from '../db/schema';
import { slugify } from '../databases/databases.service';

type Field = typeof fields.$inferSelect;

/** Allowed type conversions — docs/architecture/record-storage.md (field lifecycle). */
const CONVERTIBLE: Record<string, CreatableFieldType[]> = {
  text: ['number', 'date'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  select: ['text', 'multi_select'],
  multi_select: ['text', 'select'],
  url: ['text', 'email'],
  email: ['text', 'url'],
  user: [],
};

@Injectable()
export class FieldsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getField(databaseId: string, fieldId: string): Promise<Field> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, fieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    if (!field) throw new NotFoundException('Field not found');
    return field;
  }

  private async uniqueApiName(databaseId: string, displayName: string): Promise<string> {
    const root = slugify(displayName);
    const taken = new Set(
      (
        await this.db.query.fields.findMany({
          where: eq(fields.databaseId, databaseId), // includes soft-deleted: api_name unique index covers them
          columns: { apiName: true },
        })
      ).map((f) => f.apiName),
    );
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Count of live records carrying a value for this field. */
  async usageCount(databaseId: string, fieldId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, databaseId),
          isNull(records.deletedAt),
          sql`${records.values} ? ${fieldId}`,
        ),
      );
    return row?.count ?? 0;
  }

  async create(
    databaseId: string,
    input: {
      display_name: string;
      type: CreatableFieldType;
      config?: Record<string, unknown>;
      options?: Array<{ label: string; color?: string }>;
    },
  ) {
    const apiName = await this.uniqueApiName(databaseId, input.display_name);
    const siblings = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), eq(fields.isSystem, false)),
      columns: { position: true },
    });
    const position = Math.max(0, ...siblings.map((f) => f.position)) + 1;

    return this.db.transaction(async (tx) => {
      const [field] = await tx
        .insert(fields)
        .values({
          databaseId,
          displayName: input.display_name,
          apiName,
          type: input.type,
          config: input.config ?? {},
          position,
        })
        .returning();

      if (
        (input.type === 'select' || input.type === 'multi_select') &&
        input.options &&
        input.options.length > 0
      ) {
        await tx.insert(selectOptions).values(
          input.options.map((option, i) => ({
            fieldId: field!.id,
            label: option.label,
            color: option.color ?? 'gray',
            position: i,
          })),
        );
      }
      return this.withOptions(tx as unknown as Db, field!);
    });
  }

  private async withOptions(db: Db, field: Field) {
    if (field.type !== 'select' && field.type !== 'multi_select') return field;
    const options = await db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, field.id),
      orderBy: [asc(selectOptions.position)],
    });
    return { ...field, options };
  }

  async update(
    databaseId: string,
    fieldId: string,
    patch: { display_name?: string; config?: Record<string, unknown>; position?: number },
  ) {
    const field = await this.getField(databaseId, fieldId);
    if (field.isSystem) throw new UnprocessableEntityException('System fields cannot be edited');

    const [updated] = await this.db
      .update(fields)
      .set({
        displayName: patch.display_name,
        config: patch.config ? { ...(field.config as object), ...patch.config } : undefined,
        position: patch.position,
      })
      .where(eq(fields.id, fieldId))
      .returning();
    return this.withOptions(this.db, updated!);
  }

  /** Soft delete (B6). Title/system fields are protected; relation fields belong to MN-018. */
  async remove(databaseId: string, fieldId: string) {
    const field = await this.getField(databaseId, fieldId);
    if (field.type === 'title') throw new UnprocessableEntityException('The title field cannot be deleted');
    if (field.isSystem) throw new UnprocessableEntityException('System fields cannot be deleted');
    if (field.type === 'relation') {
      throw new UnprocessableEntityException('Delete relation fields via the relations API');
    }
    const recordsWithValue = await this.usageCount(databaseId, fieldId);
    await this.db.update(fields).set({ deletedAt: new Date() }).where(eq(fields.id, fieldId));
    return { deleted: true, records_with_value: recordsWithValue };
  }

  /**
   * Type change within the compatibility matrix. dry_run returns the lossy
   * count without applying. Conversion runs in one transaction (per-row —
   * fine at v1 scale, documented in record-storage.md).
   */
  async changeType(databaseId: string, fieldId: string, targetType: CreatableFieldType, dryRun: boolean) {
    const field = await this.getField(databaseId, fieldId);
    if (field.isSystem || field.type === 'title' || field.type === 'relation') {
      throw new UnprocessableEntityException(`Type of ${field.type} fields cannot be changed`);
    }
    if (field.type === targetType) throw new BadRequestException('Field already has this type');
    if (!CONVERTIBLE[field.type]?.includes(targetType)) {
      throw new UnprocessableEntityException(
        `Cannot convert ${field.type} → ${targetType}. Allowed: ${(CONVERTIBLE[field.type] ?? []).join(', ') || 'none'}. Delete and recreate the field instead.`,
      );
    }

    const optionLabels = new Map(
      (
        await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, fieldId) })
      ).map((o) => [o.id, o.label]),
    );

    const rows = await this.db.query.records.findMany({
      where: and(
        eq(records.databaseId, databaseId),
        isNull(records.deletedAt),
        sql`${records.values} ? ${fieldId}`,
      ),
      columns: { id: true, values: true },
    });

    let lossy = 0;
    const updates: Array<{ id: string; value: unknown }> = [];
    for (const row of rows) {
      const current = (row.values as Record<string, unknown>)[fieldId];
      const { value, lost } = convertValue(current, field.type, targetType, optionLabels);
      if (lost) lossy++;
      updates.push({ id: row.id, value });
    }

    if (dryRun) {
      return { dry_run: true, records_affected: rows.length, lossy_conversions: lossy };
    }

    await this.db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(records)
          .set({
            values:
              u.value === null
                ? sql`${records.values} - ${fieldId}::text`
                : sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], ${JSON.stringify(u.value)}::jsonb)`,
          })
          .where(eq(records.id, u.id));
      }
      await tx.update(fields).set({ type: targetType, config: {} }).where(eq(fields.id, fieldId));
      if (field.type === 'select' || field.type === 'multi_select') {
        if (targetType !== 'select' && targetType !== 'multi_select') {
          await tx.delete(selectOptions).where(eq(selectOptions.fieldId, fieldId));
        }
      }
    });

    return { dry_run: false, records_affected: rows.length, lossy_conversions: lossy };
  }

  // --- Select options ---

  private async assertSelectField(databaseId: string, fieldId: string) {
    const field = await this.getField(databaseId, fieldId);
    if (field.type !== 'select' && field.type !== 'multi_select') {
      throw new UnprocessableEntityException('Not a select field');
    }
    return field;
  }

  async addOption(databaseId: string, fieldId: string, input: { label: string; color: string }) {
    await this.assertSelectField(databaseId, fieldId);
    const existing = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, fieldId),
      columns: { position: true },
    });
    const [option] = await this.db
      .insert(selectOptions)
      .values({
        fieldId,
        label: input.label,
        color: input.color,
        position: Math.max(-1, ...existing.map((o) => o.position)) + 1,
      })
      .returning();
    return option!;
  }

  async updateOption(
    databaseId: string,
    fieldId: string,
    optionId: string,
    patch: { label?: string; color?: string; position?: number },
  ) {
    await this.assertSelectField(databaseId, fieldId);
    const [option] = await this.db
      .update(selectOptions)
      .set(patch)
      .where(and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, fieldId)))
      .returning();
    if (!option) throw new NotFoundException('Option not found');
    return option;
  }

  /** Option delete: 409 with usage count unless confirmed (B5). */
  async removeOption(
    databaseId: string,
    fieldId: string,
    optionId: string,
    input: { confirm: boolean; reassign_to?: string },
  ) {
    const field = await this.assertSelectField(databaseId, fieldId);
    const option = await this.db.query.selectOptions.findFirst({
      where: and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, fieldId)),
    });
    if (!option) throw new NotFoundException('Option not found');

    const usage = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, databaseId),
          isNull(records.deletedAt),
          field.type === 'select'
            ? sql`${records.values}->>${fieldId} = ${optionId}`
            : sql`${records.values}->${fieldId} ? ${optionId}`,
        ),
      );
    const count = usage[0]?.count ?? 0;

    if (count > 0 && !input.confirm) {
      throw new ConflictException(`Option is used by ${count} record(s). Pass confirm: true to clear.`);
    }

    await this.db.transaction(async (tx) => {
      if (count > 0) {
        if (field.type === 'select') {
          await tx
            .update(records)
            .set({
              values: input.reassign_to
                ? sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], ${JSON.stringify(input.reassign_to)}::jsonb)`
                : sql`${records.values} - ${fieldId}::text`,
            })
            .where(and(eq(records.databaseId, databaseId), sql`${records.values}->>${fieldId} = ${optionId}`));
        } else {
          await tx
            .update(records)
            .set({
              values: input.reassign_to
                ? sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], (${records.values}->${fieldId}) - ${optionId} || ${JSON.stringify([input.reassign_to])}::jsonb)`
                : sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], (${records.values}->${fieldId}) - ${optionId})`,
            })
            .where(and(eq(records.databaseId, databaseId), sql`${records.values}->${fieldId} ? ${optionId}`));
        }
      }
      await tx.delete(selectOptions).where(eq(selectOptions.id, optionId));
    });

    return { deleted: true, records_cleared: input.reassign_to ? 0 : count };
  }
}

function convertValue(
  value: unknown,
  from: string,
  to: CreatableFieldType,
  optionLabels: Map<string, string>,
): { value: unknown; lost: boolean } {
  if (value === null || value === undefined) return { value: null, lost: false };

  if (to === 'text') {
    if (from === 'select') return { value: optionLabels.get(String(value)) ?? null, lost: !optionLabels.has(String(value)) };
    if (from === 'multi_select') {
      const labels = (value as string[]).map((id) => optionLabels.get(id)).filter(Boolean);
      return { value: labels.join(', '), lost: labels.length !== (value as string[]).length };
    }
    return { value: String(value), lost: false };
  }
  if (to === 'number') {
    const n = Number.parseFloat(String(value).replace(/,/g, '.'));
    return Number.isFinite(n) ? { value: n, lost: false } : { value: null, lost: true };
  }
  if (to === 'date') {
    const ms = Date.parse(String(value));
    return Number.isNaN(ms)
      ? { value: null, lost: true }
      : { value: new Date(ms).toISOString().slice(0, 10), lost: false };
  }
  if (to === 'multi_select' && from === 'select') return { value: [value], lost: false };
  if (to === 'select' && from === 'multi_select') {
    const arr = value as string[];
    return { value: arr[0] ?? null, lost: arr.length > 1 };
  }
  if ((to === 'url' && from === 'email') || (to === 'email' && from === 'url')) {
    return { value: String(value), lost: false };
  }
  return { value: null, lost: true };
}
