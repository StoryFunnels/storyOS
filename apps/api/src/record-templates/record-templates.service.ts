import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  blocksToMarkdown,
  markdownToBlocks,
  resolveSampleDate,
  SAMPLE_ME,
  type CreateRecordTemplate,
  type RecordTemplate,
  type UpdateRecordTemplate,
} from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { recordTemplates } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { DocumentsService } from '../documents/documents.service';
import { RecordsService } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';

type Row = typeof recordTemplates.$inferSelect;

/** Field types a template never captures from a record: computed, linked, or the record's own identity. */
const NOT_TEMPLATABLE = new Set([
  'id',
  'relation',
  'lookup',
  'rollup',
  'formula',
  'button',
  'title',
  'created_at',
  'updated_at',
  'created_by',
]);

const OPTION_TYPES = new Set(['select', 'multi_select', 'workflow']);

export const publicRecordTemplate = (row: Row): RecordTemplate => ({
  id: row.id,
  database_id: row.databaseId,
  name: row.name,
  description: row.description,
  values: (row.values ?? {}) as Record<string, unknown>,
  body: row.body,
  origin: row.origin === 'pack' ? 'pack' : 'user',
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

/**
 * ticket #1218 - record templates. A template belongs to one database, is shared by everyone who can see that database, and is
 * edited and deleted like any other content. Packs install theirs through `PacksService.installRecordTemplates`, which writes
 * straight into this table; nothing here knows about packs.
 */
@Injectable()
export class RecordTemplatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
    private readonly documents: DocumentsService,
  ) {}

  async list(databaseId: string): Promise<RecordTemplate[]> {
    const rows = await this.db.query.recordTemplates.findMany({
      where: eq(recordTemplates.databaseId, databaseId),
      orderBy: [asc(recordTemplates.createdAt), asc(recordTemplates.name)],
    });
    return rows.map(publicRecordTemplate);
  }

  async get(databaseId: string, templateId: string): Promise<RecordTemplate> {
    return publicRecordTemplate(await this.row(databaseId, templateId));
  }

  async create(membership: Membership, databaseId: string, input: CreateRecordTemplate, origin: 'pack' | 'user' = 'user'): Promise<RecordTemplate> {
    await this.assertNameFree(databaseId, input.name);
    const [row] = await this.db
      .insert(recordTemplates)
      .values({
        workspaceId: membership.workspaceId,
        databaseId,
        name: input.name,
        description: input.description ?? null,
        values: input.values ?? {},
        body: input.body?.trim() ? input.body : null,
        origin,
        createdBy: membership.userId,
      })
      .returning();
    return publicRecordTemplate(row!);
  }

  /** "Save as template": values and description are read off the record as they are now. Relations, computed fields and the title are not copied. */
  async saveFromRecord(
    membership: Membership,
    databaseId: string,
    recordId: string,
    input: { name: string; description?: string },
  ): Promise<RecordTemplate> {
    const source = await this.records.get(databaseId, recordId);
    const defs = await this.records.fieldDefs(databaseId);
    const values: Record<string, unknown> = {};
    for (const def of defs) {
      if (NOT_TEMPLATABLE.has(def.type)) continue;
      const v = source.values[def.api_name];
      if (v !== undefined && v !== null) values[def.api_name] = v;
    }
    const doc = await this.documents.get(recordId);
    const body = Array.isArray(doc.content) ? blocksToMarkdown(doc.content as never).trim() : '';
    return this.create(membership, databaseId, { name: input.name, description: input.description, values, body: body || undefined });
  }

  async update(databaseId: string, templateId: string, patch: UpdateRecordTemplate): Promise<RecordTemplate> {
    const current = await this.row(databaseId, templateId);
    if (patch.name !== undefined && patch.name.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
      await this.assertNameFree(databaseId, patch.name);
    }
    const set: Partial<typeof recordTemplates.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.values !== undefined) set.values = patch.values;
    if (patch.body !== undefined) set.body = patch.body?.trim() ? patch.body : null;
    if (Object.keys(set).length === 0) return publicRecordTemplate(current);
    const [row] = await this.db.update(recordTemplates).set(set).where(eq(recordTemplates.id, templateId)).returning();
    return publicRecordTemplate(row!);
  }

  async remove(databaseId: string, templateId: string): Promise<void> {
    await this.row(databaseId, templateId);
    await this.db.delete(recordTemplates).where(eq(recordTemplates.id, templateId));
  }

  /**
   * Make a record from a template: the template's values (with `$me` / `$date:` decided now) under the caller's `overrides`, then the
   * template's body as the record's description. A template value for a field that no longer exists, or naming an option that was
   * since deleted, is DROPPED and reported in `skipped` rather than failing the create: a template outlives the schema edits around
   * it, and a half-stale template should still open a usable record.
   */
  async apply(
    membership: Membership,
    databaseId: string,
    templateId: string,
    overrides: Record<string, unknown>,
    ctx: { source: ChangeSource; agentId?: string; agentName?: string },
  ) {
    const template = await this.row(databaseId, templateId);
    const defs = await this.records.fieldDefs(databaseId);
    const byName = new Map(defs.map((d) => [d.api_name, d] as const));
    const skipped: Array<{ field: string; reason: string }> = [];
    const values: Record<string, unknown> = {};

    for (const [field, raw] of Object.entries((template.values ?? {}) as Record<string, unknown>)) {
      const def = byName.get(field);
      if (!def) {
        skipped.push({ field, reason: 'the field no longer exists' });
        continue;
      }
      const resolved = this.resolveTokens(raw, membership.userId);
      if (OPTION_TYPES.has(def.type) && def.option_ids) {
        const ids = new Set(def.option_ids);
        const wanted = Array.isArray(resolved) ? resolved : [resolved];
        if (wanted.some((id) => typeof id !== 'string' || !ids.has(id))) {
          skipped.push({ field, reason: 'an option it names no longer exists' });
          continue;
        }
      }
      values[field] = resolved;
    }
    Object.assign(values, overrides);

    const created = await this.records.create(
      membership.workspaceId,
      databaseId,
      values,
      membership.userId,
      0,
      ctx.source,
      ctx.agentId,
      ctx.agentName,
      membership,
    );
    if (template.body?.trim()) {
      await this.documents.put(membership.workspaceId, databaseId, created.id, markdownToBlocks(template.body), 0, membership.userId, ctx.source);
    }
    return { record: await this.records.narrowTitlesDeep(membership, created), skipped };
  }

  private resolveTokens(value: unknown, userId: string): unknown {
    if (typeof value === 'string') {
      if (value === SAMPLE_ME) return userId;
      return resolveSampleDate(value) ?? value;
    }
    if (Array.isArray(value)) return value.map((v) => this.resolveTokens(v, userId));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolveTokens(v, userId)]));
    }
    return value;
  }

  private async row(databaseId: string, templateId: string): Promise<Row> {
    const row = await this.db.query.recordTemplates.findFirst({
      where: and(eq(recordTemplates.id, templateId), eq(recordTemplates.databaseId, databaseId)),
    });
    if (!row) throw new NotFoundException('Template not found');
    return row;
  }

  private async assertNameFree(databaseId: string, name: string): Promise<void> {
    const existing = await this.db.query.recordTemplates.findMany({ where: eq(recordTemplates.databaseId, databaseId) });
    if (existing.some((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      throw new ConflictException(`This database already has a template named "${name}".`);
    }
  }
}
