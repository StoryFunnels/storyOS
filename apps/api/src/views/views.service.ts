import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { ViewConfig, ViewType } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, views } from '../db/schema';

type FieldRow = typeof fields.$inferSelect;

/** Drops references to fields that no longer exist (defensive read, C-series ACs). */
export function cleanViewConfig(
  config: ViewConfig,
  liveFieldIds: Set<string>,
  liveApiNames: Set<string>,
): ViewConfig {
  const cleanFilters = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return undefined;
    if ('and' in (node as object) || 'or' in (node as object)) {
      const key = 'and' in (node as object) ? 'and' : 'or';
      const children = ((node as Record<string, unknown[]>)[key] ?? [])
        .map(cleanFilters)
        .filter(Boolean);
      return children.length > 0 ? { [key]: children } : undefined;
    }
    const condition = node as { field?: string };
    return condition.field && liveApiNames.has(condition.field) ? node : undefined;
  };

  return {
    filters: config.filters ? (cleanFilters(config.filters) as ViewConfig['filters']) : undefined,
    sorts: (config.sorts ?? []).filter((s) => liveApiNames.has(s.field)),
    hidden_field_ids: (config.hidden_field_ids ?? []).filter((id) => liveFieldIds.has(id)),
    group_by_field_id:
      config.group_by_field_id && liveFieldIds.has(config.group_by_field_id)
        ? config.group_by_field_id
        : undefined,
    color_by_field_id:
      config.color_by_field_id && liveFieldIds.has(config.color_by_field_id)
        ? config.color_by_field_id
        : undefined,
    card_field_ids: (config.card_field_ids ?? []).filter((id) => liveFieldIds.has(id)),
    card_size: config.card_size,
    date_field_id:
      config.date_field_id && liveFieldIds.has(config.date_field_id)
        ? config.date_field_id
        : undefined,
    start_date_field_id:
      config.start_date_field_id && liveFieldIds.has(config.start_date_field_id)
        ? config.start_date_field_id
        : undefined,
    end_date_field_id:
      config.end_date_field_id && liveFieldIds.has(config.end_date_field_id)
        ? config.end_date_field_id
        : undefined,
    form: config.form,
    column_widths: Object.fromEntries(
      Object.entries(config.column_widths ?? {}).filter(([id]) => liveFieldIds.has(id)),
    ),
  };
}

@Injectable()
export class ViewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async liveFields(databaseId: string): Promise<FieldRow[]> {
    return this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
  }

  /** Validates that every field reference in the config exists (422 otherwise). */
  private async validateConfig(databaseId: string, type: ViewType, config: ViewConfig) {
    const live = await this.liveFields(databaseId);
    const byId = new Map(live.map((f) => [f.id, f]));
    const apiNames = new Set(live.map((f) => f.apiName));

    const referencedIds = [
      ...(config.hidden_field_ids ?? []),
      ...(config.card_field_ids ?? []),
      ...Object.keys(config.column_widths ?? {}),
      ...(config.group_by_field_id ? [config.group_by_field_id] : []),
      ...(config.date_field_id ? [config.date_field_id] : []),
    ];
    for (const id of referencedIds) {
      if (!byId.has(id)) throw new UnprocessableEntityException(`unknown field id "${id}" in view config`);
    }

    const checkFilterNames = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if ('and' in (node as object) || 'or' in (node as object)) {
        const children =
          ((node as Record<string, unknown[]>)['and'] ??
            (node as Record<string, unknown[]>)['or']) ?? [];
        children.forEach(checkFilterNames);
        return;
      }
      const field = (node as { field?: string }).field;
      if (field && !apiNames.has(field)) {
        throw new UnprocessableEntityException(`unknown field "${field}" in view filters`);
      }
    };
    if (config.filters) checkFilterNames(config.filters);
    for (const sort of config.sorts ?? []) {
      if (!apiNames.has(sort.field)) {
        throw new UnprocessableEntityException(`unknown sort field "${sort.field}" in view config`);
      }
    }

    if (type === 'board') {
      if (!config.group_by_field_id) {
        throw new UnprocessableEntityException('board views require group_by_field_id');
      }
      const groupField = byId.get(config.group_by_field_id);
      if (groupField?.type !== 'select') {
        throw new UnprocessableEntityException('board views must group by a single-select field (v1)');
      }
    }
  }

  async create(
    databaseId: string,
    input: { name: string; type: ViewType; config: ViewConfig },
    createdBy: string,
  ) {
    await this.validateConfig(databaseId, input.type, input.config);
    const siblings = await this.db.query.views.findMany({
      where: eq(views.databaseId, databaseId),
      columns: { position: true },
    });
    const [view] = await this.db
      .insert(views)
      .values({
        databaseId,
        name: input.name,
        type: input.type,
        config: input.config,
        position: Math.max(-1, ...siblings.map((v) => v.position)) + 1,
        createdBy,
      })
      .returning();
    return view!;
  }

  async update(
    databaseId: string,
    viewId: string,
    patch: { name?: string; config?: ViewConfig; position?: number },
  ) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId)),
    });
    if (!view) throw new NotFoundException('View not found');
    if (patch.config) await this.validateConfig(databaseId, view.type, patch.config);

    const [updated] = await this.db
      .update(views)
      .set({ name: patch.name, config: patch.config, position: patch.position })
      .where(eq(views.id, viewId))
      .returning();
    return updated!;
  }

  /** Every database keeps ≥1 view (C7). */
  async remove(databaseId: string, viewId: string) {
    const all = await this.db.query.views.findMany({ where: eq(views.databaseId, databaseId) });
    if (!all.some((v) => v.id === viewId)) throw new NotFoundException('View not found');
    if (all.length <= 1) throw new ConflictException('A database must keep at least one view');
    await this.db.delete(views).where(eq(views.id, viewId));
    return { deleted: true };
  }
}
