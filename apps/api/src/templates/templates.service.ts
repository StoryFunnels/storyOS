import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, workspaces } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import { ViewsService } from '../views/views.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { TEMPLATES } from './definitions';

/**
 * Template installer (MN-032): everything goes through the SAME service layer
 * the public API uses — a template is just a scripted sequence of ordinary
 * calls, which keeps templates honest about API completeness.
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
      data: TEMPLATES.map((t) => ({ slug: t.slug, name: t.name, description: t.description })),
    };
  }

  async apply(membership: Membership, slug: string, actorId: string) {
    const template = TEMPLATES.find((t) => t.slug === slug);
    if (!template) throw new NotFoundException('Template not found');

    const space = await this.spaces.create(membership.workspaceId, { name: template.space });

    // 1. Databases + fields (option ids collected by label for sample data).
    const dbIds = new Map<string, string>();
    const fieldApi = new Map<string, string>(); // "<db>.<key>" -> api_name
    const fieldIds = new Map<string, string>(); // "<db>.<key>" -> field id
    const optionIds = new Map<string, string>(); // "<db>.<key>.<label>" -> option id

    for (const dbDef of template.databases) {
      const database = await this.databases.create(membership, {
        space_id: space.id,
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
        fieldApi.set(`${dbDef.key}.${fieldDef.key}`, field.apiName);
        fieldIds.set(`${dbDef.key}.${fieldDef.key}`, field.id);
        for (const option of field.options ?? []) {
          optionIds.set(`${dbDef.key}.${fieldDef.key}.${option.label}`, option.id);
        }
      }
    }

    // 2. Relations.
    const relationFieldIds = new Map<string, string>(); // relation key -> field id on side A
    for (const relation of template.relations) {
      const created = await this.relationsService.create(membership, {
        database_a_id: dbIds.get(relation.database_a)!,
        database_b_id: dbIds.get(relation.database_b)!,
        cardinality: relation.cardinality,
        field_a_name: relation.field_a_name,
        field_b_name: relation.field_b_name,
      });
      relationFieldIds.set(relation.key, created.field_a.id);
    }

    // 3. Views.
    for (const viewDef of template.views) {
      const databaseId = dbIds.get(viewDef.database)!;
      await this.views.create(
        databaseId,
        {
          name: viewDef.name,
          type: viewDef.type,
          config: {
            sorts: (viewDef.sorts ?? []) as never,
            hidden_field_ids: [],
            card_field_ids: [],
            column_widths: {},
            ...(viewDef.group_by_field
              ? { group_by_field_id: fieldIds.get(viewDef.group_by_field)! }
              : {}),
            ...(viewDef.filters ? { filters: viewDef.filters as never } : {}),
          } as never,
        },
        actorId,
      );
    }

    // 4. Sample records (+ links), tracked in workspace settings for removal.
    const recordIds = new Map<string, string>();
    const sampleIds: string[] = [];
    for (const recordDef of template.records) {
      const dbKey = recordDef.database;
      const values: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(recordDef.values)) {
        if (key === 'name') {
          values.name = raw;
          continue;
        }
        const apiName = fieldApi.get(`${dbKey}.${key}`);
        if (!apiName) continue;
        const optionId = optionIds.get(`${dbKey}.${key}.${String(raw)}`);
        values[apiName] = optionId ?? raw;
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

    return {
      applied: slug,
      space_id: space.id,
      databases: Object.fromEntries(dbIds),
      sample_records: sampleIds.length,
    };
  }

  private async trackSamples(workspaceId: string, ids: string[]) {
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
