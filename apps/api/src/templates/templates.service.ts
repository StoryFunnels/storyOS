import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, records, workspaces } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import { ViewsService } from '../views/views.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { INTENTS, TEMPLATES } from './definitions';
import type { TemplateFilterDef } from './types';

export interface ApplyOptions {
  /** Required for scope=database templates; packs create their own space. */
  space_id?: string;
  /** Rename the pack's space at install (Client Space → the client's name). */
  space_name?: string;
  include_samples?: boolean;
}

/**
 * Template installer (MN-032/033/035-037): everything goes through the SAME
 * service layer as the public API. Resolves option labels → ids, '@me' → the
 * installer / me-token, and cross-pack relations to existing databases.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databases: DatabasesService,
    private readonly fields: FieldsService,
    private readonly relationsService: RelationsService,
    private readonly recordsService: RecordsService,
    private readonly views: ViewsService,
  ) {}

  list() {
    return {
      data: TEMPLATES.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        category: t.category,
        scope: t.scope,
        preview: {
          databases: t.databases.map((d) => ({
            name: d.name,
            fields: d.fields.map((f) => ({ name: f.display_name, type: f.type })),
          })),
          views: t.views.map((v) => ({ database: t.databases.find((d) => d.key === v.database)?.name, name: v.name, type: v.type })),
          relations: t.relations.map((r) => {
            const a = t.databases.find((d) => d.key === r.database_a)?.name ?? r.database_a;
            const b = r.external_target_name ?? t.databases.find((d) => d.key === r.database_b)?.name ?? r.database_b;
            return `${a} ↔ ${b}`;
          }),
        },
      })),
      intents: INTENTS,
    };
  }

  async apply(membership: Membership, slug: string, actorId: string, options: ApplyOptions = {}) {
    const template = TEMPLATES.find((t) => t.slug === slug);
    if (!template) throw new NotFoundException('Template not found');
    const includeSamples = options.include_samples !== false;
    const notes: string[] = [];

    // Target space: packs create one (renameable); database templates need a target.
    let spaceId = options.space_id;
    if (template.scope === 'pack') {
      const space = await this.spaces.create(membership.workspaceId, {
        name: options.space_name?.trim() || template.space || template.name,
      });
      spaceId = space.id;
    } else if (!spaceId) {
      const all = await this.spaces.list(membership);
      spaceId = all[0]?.id;
      if (!spaceId) throw new NotFoundException('No space to install into — pass space_id');
    }

    // 1. Databases + fields.
    const dbIds = new Map<string, string>();
    const fieldApi = new Map<string, string>(); // "<db>.<key>" -> api_name
    const fieldIds = new Map<string, string>();
    const fieldTypes = new Map<string, string>();
    const optionIds = new Map<string, string>(); // "<db>.<key>.<label>" -> id

    for (const dbDef of template.databases) {
      const database = await this.databases.create(membership, {
        space_id: spaceId!,
        name: dbDef.name,
        icon: dbDef.icon,
      });
      dbIds.set(dbDef.key, database.id);
      for (const fieldDef of dbDef.fields) {
        const field = (await this.fields.create(database.id, {
          display_name: fieldDef.display_name,
          type: fieldDef.type,
          config: fieldDef.config,
          options: fieldDef.options,
        })) as { id: string; apiName: string; options?: Array<{ id: string; label: string }> };
        const ref = `${dbDef.key}.${fieldDef.key}`;
        fieldApi.set(ref, field.apiName);
        fieldIds.set(ref, field.id);
        fieldTypes.set(ref, fieldDef.type);
        for (const option of field.options ?? []) {
          optionIds.set(`${ref}.${option.label}`, option.id);
        }
      }
    }

    // 2. Relations (internal, self, and cross-pack external).
    const relationFieldIds = new Map<string, string>();
    for (const relation of template.relations) {
      let targetDbId: string | undefined;
      if (relation.external_target_name) {
        const all = await this.db.query.databases.findMany({
          where: eq(databasesTable.workspaceId, membership.workspaceId),
        });
        targetDbId = all.find((d) => d.name === relation.external_target_name)?.id;
        if (!targetDbId) {
          notes.push(
            `Skipped relation to "${relation.external_target_name}" — no such database in this workspace yet.`,
          );
          continue;
        }
      } else {
        targetDbId = dbIds.get(relation.database_b!);
      }
      const created = await this.relationsService.create(membership, {
        database_a_id: dbIds.get(relation.database_a)!,
        database_b_id: targetDbId!,
        cardinality: relation.cardinality,
        field_a_name: relation.field_a_name,
        field_b_name: relation.field_b_name,
      });
      relationFieldIds.set(relation.key, created.field_a.id);
    }

    // 3. Views (filters resolve option labels + '@me').
    for (const viewDef of template.views) {
      const databaseId = dbIds.get(viewDef.database)!;
      const resolveFilter = (f: TemplateFilterDef): Record<string, unknown> => {
        const ref = `${viewDef.database}.${f.field}`;
        const apiName = fieldApi.get(ref)!;
        const type = fieldTypes.get(ref);
        if (f.values) {
          const resolved = f.values.map((v) => {
            if (v === '@me') return 'me';
            if (type === 'select' || type === 'multi_select') {
              return optionIds.get(`${ref}.${String(v)}`) ?? v;
            }
            return v;
          });
          return { field: apiName, op: f.op, value: resolved };
        }
        return { field: apiName, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) };
      };

      const filters =
        viewDef.filters && viewDef.filters.length > 0
          ? viewDef.filters.length === 1
            ? resolveFilter(viewDef.filters[0]!)
            : { and: viewDef.filters.map(resolveFilter) }
          : undefined;

      await this.views.create(
        databaseId,
        {
          name: viewDef.name,
          type: viewDef.type,
          config: {
            sorts: (viewDef.sorts ?? []).map((s) => ({
              field: fieldApi.get(`${viewDef.database}.${s.field}`)!,
              direction: s.direction,
            })) as never,
            hidden_field_ids: [],
            card_field_ids: [],
            column_widths: {},
            ...(viewDef.group_by_field
              ? { group_by_field_id: fieldIds.get(`${viewDef.database}.${viewDef.group_by_field}`)! }
              : {}),
            ...(filters ? { filters: filters as never } : {}),
          } as never,
        },
        actorId,
      );
    }

    // 4. Sample records.
    const recordIds = new Map<string, string>();
    const sampleIds: string[] = [];
    if (includeSamples) {
      for (const recordDef of template.records) {
        const dbKey = recordDef.database;
        const values: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(recordDef.values)) {
          if (key === 'name') {
            values.name = raw;
            continue;
          }
          const ref = `${dbKey}.${key}`;
          const apiName = fieldApi.get(ref);
          if (!apiName) continue;
          const type = fieldTypes.get(ref);
          if (raw === '@me') {
            values[apiName] = actorId;
          } else if (type === 'multi_select' && Array.isArray(raw)) {
            values[apiName] = raw.map((label) => optionIds.get(`${ref}.${String(label)}`) ?? label);
          } else if (type === 'select') {
            values[apiName] = optionIds.get(`${ref}.${String(raw)}`) ?? raw;
          } else {
            values[apiName] = raw;
          }
        }
        const created = await this.recordsService.create(
          membership.workspaceId,
          dbIds.get(dbKey)!,
          values,
          actorId,
        );
        sampleIds.push(created.id);
        if (recordDef.key) recordIds.set(recordDef.key, created.id);

        for (const link of recordDef.links ?? []) {
          const target = recordIds.get(link.to);
          const fieldId = relationFieldIds.get(link.relation);
          if (target && fieldId) {
            await this.relationsService.addLinks(
              membership.workspaceId,
              dbIds.get(dbKey)!,
              created.id,
              fieldId,
              [target],
              actorId,
            );
          }
        }
      }
      await this.trackSamples(membership.workspaceId, sampleIds);
    }

    return {
      applied: slug,
      space_id: spaceId,
      databases: Object.fromEntries(dbIds),
      sample_records: sampleIds.length,
      notes,
    };
  }

  private async trackSamples(workspaceId: string, ids: string[]) {
    if (ids.length === 0) return;
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const existing = (settings.sample_record_ids as string[]) ?? [];
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, sample_record_ids: [...existing, ...ids] } })
      .where(eq(workspaces.id, workspaceId));
  }

  /** "Remove sample data" — deletes exactly the tracked records (F1). */
  async removeSampleData(workspaceId: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const ids = (settings.sample_record_ids as string[]) ?? [];
    if (ids.length > 0) {
      await this.db.delete(records).where(inArray(records.id, ids));
    }
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, sample_record_ids: [] } })
      .where(eq(workspaces.id, workspaceId));
    return { removed: ids.length };
  }
}
