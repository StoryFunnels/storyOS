import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automations as automationsTable, databases as databasesTable, records, workspaces } from '../db/schema';
import { missingConnections } from '../connections/missing-connections';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService, OPTIONED_FIELD_TYPES, SINGLE_OPTION_FIELD_TYPES } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import { ViewsService } from '../views/views.service';
import { AutomationsService } from '../automations/automations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { INTENTS, TEMPLATES } from './definitions';
import type { TemplateFilterDef } from './types';

export interface ApplyOptions {
  /** Required for scope=database templates; packs create their own space. */
  space_id?: string;
  /** Rename the pack's space at install (Client Space → the client's name). */
  space_name?: string;
  /** Rename a single-database template at install (Calendar → Team Calendar). */
  database_name?: string;
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
    private readonly automations: AutomationsService,
  ) {}

  list() {
    return {
      data: TEMPLATES.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        category: t.category,
        scope: t.scope,
        guide: t.guide ?? null,
        preview: {
          databases: t.databases.map((d) => ({
            name: d.name,
            fields: d.fields.map((f) => ({ name: f.display_name, type: f.type })),
          })),
          views: t.views.map((v) => ({
            database: t.databases.find((d) => d.key === v.database)?.name,
            name: v.name,
            type: v.type,
          })),
          relations: t.relations.map((r) => {
            const a = t.databases.find((d) => d.key === r.database_a)?.name ?? r.database_a;
            const b =
              r.external_target_name ??
              t.databases.find((d) => d.key === r.database_b)?.name ??
              r.database_b;
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
        name:
          template.scope === 'database' && template.databases.length === 1
            ? options.database_name?.trim() || dbDef.name
            : dbDef.name,
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
            if (type && OPTIONED_FIELD_TYPES.has(type)) {
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
            card_field_ids: (viewDef.card_fields ?? [])
              .map((key) => fieldIds.get(`${viewDef.database}.${key}`))
              .filter((id): id is string => !!id),
            column_widths: {},
            ...(viewDef.group_by_field
              ? {
                  group_by_field_id: fieldIds.get(`${viewDef.database}.${viewDef.group_by_field}`)!,
                }
              : {}),
            ...(viewDef.date_field
              ? { date_field_id: fieldIds.get(`${viewDef.database}.${viewDef.date_field}`)! }
              : {}),
            ...(viewDef.start_date_field
              ? { start_date_field_id: fieldIds.get(`${viewDef.database}.${viewDef.start_date_field}`)! }
              : {}),
            ...(viewDef.end_date_field
              ? { end_date_field_id: fieldIds.get(`${viewDef.database}.${viewDef.end_date_field}`)! }
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
          } else if (type && SINGLE_OPTION_FIELD_TYPES.has(type)) {
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

    /*
     * 5. Automations (#455) — always DISABLED.
     *
     * Same routine, same maps, same service layer as everything above; a pack's
     * rules are not a second install path. `enabled: false` is passed
     * explicitly here AND typed as the literal false on TemplateAutomationDef,
     * so neither the definition nor this call site can switch a rule on in
     * someone else's workspace.
     *
     * Not tracked as sample data: a rule is configuration, and "Remove sample
     * data" must not silently delete the pack's rules along with its rows.
     */
    const automationIds: string[] = [];
    for (const ruleDef of template.automations ?? []) {
      const databaseId = dbIds.get(ruleDef.database);
      if (!databaseId) {
        notes.push(`Skipped automation "${ruleDef.name}" — it names an unknown database in this pack.`);
        continue;
      }
      const rule = await this.automations.create(
        membership.workspaceId,
        databaseId,
        {
          name: ruleDef.name,
          trigger: this.resolvePackRefs(ruleDef.trigger, ruleDef.database, fieldApi, fieldIds, optionIds) as never,
          ...(ruleDef.condition
            ? { condition: this.resolvePackRefs(ruleDef.condition, ruleDef.database, fieldApi, fieldIds, optionIds) }
            : {}),
          actions: ruleDef.actions.map(
            (a) => this.resolvePackRefs(a, ruleDef.database, fieldApi, fieldIds, optionIds) as never,
          ),
          enabled: false,
        },
        actorId,
      );
      automationIds.push(rule.id);
      // Persist the requirement on the rule so the enable guard enforces exactly
      // what the pack declared, through the same helper that worded this note.
      if (ruleDef.requires_connections?.length) {
        await this.db
          .update(automationsTable)
          .set({ requiresConnections: ruleDef.requires_connections })
          .where(eq(automationsTable.id, rule.id));
      }
      const missing = await missingConnections(this.db, membership.workspaceId, ruleDef.requires_connections);
      notes.push(
        missing.length > 0
          ? `Installed "${ruleDef.name}" switched off. It needs ${missing.join(', ')} connected before it can be enabled.`
          : `Installed "${ruleDef.name}" switched off — review it, then enable it yourself.`,
      );
    }

    /*
     * 6. Suggested sources (#455) — NOTHING is created.
     *
     * A source needs a connection this workspace may not have, and silently
     * creating one that cannot authenticate hands the user a broken
     * integration they never asked for and have to diagnose. So the pack's
     * expectations are returned and noted, and the user decides.
     */
    const suggestedSources = (template.suggested_sources ?? []).map((source) => ({
      provider: source.provider,
      description: source.description,
      database_id: source.database ? (dbIds.get(source.database) ?? null) : null,
    }));
    for (const source of template.suggested_sources ?? []) {
      notes.push(`Suggested source "${source.provider}": ${source.description} (not created — connect it if you want it).`);
    }

    return {
      applied: slug,
      space_id: spaceId,
      databases: Object.fromEntries(dbIds),
      fields: Object.fromEntries(fieldIds),
      sample_records: sampleIds.length,
      automations: automationIds,
      suggested_sources: suggestedSources,
      notes,
    };
  }

  /**
   * #455 — turn a pack's symbolic field references into real ones.
   *
   * A pack definition names fields by their pack-local key, because the uuids
   * do not exist until install. Trigger/condition/action objects are walked and
   * any `field`/`field_id` key is swapped for the installed field's api_name or
   * uuid, and any `{Field Key}` token in a string becomes `{Display Name}`.
   * Everything else is passed through untouched, so a rule can use any action
   * the engine already supports without this method knowing about it.
   */
  private resolvePackRefs(
    value: unknown,
    dbKey: string,
    fieldApi: Map<string, string>,
    fieldIds: Map<string, string>,
    optionIds: Map<string, string>,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this.resolvePackRefs(v, dbKey, fieldApi, fieldIds, optionIds));
    }
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'field_id' && typeof raw === 'string') {
        out[key] = fieldIds.get(`${dbKey}.${raw}`) ?? raw;
      } else if (key === 'field' && typeof raw === 'string') {
        out[key] = fieldApi.get(`${dbKey}.${raw}`) ?? raw;
      } else if (key === 'database_id' && typeof raw === 'string') {
        out[key] = raw;
      } else if (key === 'value' && typeof raw === 'string') {
        out[key] = optionIds.get(`${dbKey}.${raw}`) ?? raw;
      } else {
        out[key] = this.resolvePackRefs(raw, dbKey, fieldApi, fieldIds, optionIds);
      }
    }
    return out;
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
