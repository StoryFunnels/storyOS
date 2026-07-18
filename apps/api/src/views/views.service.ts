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
import { fields, relations, views } from '../db/schema';

type FieldRow = typeof fields.$inferSelect;

/**
 * Recursively drops filter conditions referencing a field that no longer exists,
 * collapsing empty groups. Pure / read-time — nothing gets written back, the same
 * defensive-read shape every consumer of a stored filter tree has to apply. Shared
 * by `cleanViewConfig` (a view's own filters) and the personal filter override
 * store (#259's PreferencesService.getViewFilter) so both apply the identical rule
 * rather than forking a second walk.
 */
export function cleanFilterNode(node: unknown, liveApiNames: Set<string>): unknown {
  if (!node || typeof node !== 'object') return undefined;
  if ('and' in (node as object) || 'or' in (node as object)) {
    const key = 'and' in (node as object) ? 'and' : 'or';
    const children = ((node as Record<string, unknown[]>)[key] ?? [])
      .map((c) => cleanFilterNode(c, liveApiNames))
      .filter(Boolean);
    return children.length > 0 ? { [key]: children } : undefined;
  }
  const condition = node as { field?: string };
  return condition.field && liveApiNames.has(condition.field) ? node : undefined;
}

/**
 * Recursively 422s if any leaf condition references a field that isn't live.
 * Shared by view-config validation (below) and the personal filter override
 * store (#259), so both enforce the identical rule rather than forking a second
 * walk.
 */
export function assertFilterFieldsLive(node: unknown, liveApiNames: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if ('and' in (node as object) || 'or' in (node as object)) {
    const children =
      ((node as Record<string, unknown[]>)['and'] ?? (node as Record<string, unknown[]>)['or']) ?? [];
    children.forEach((c) => assertFilterFieldsLive(c, liveApiNames));
    return;
  }
  const field = (node as { field?: string }).field;
  if (field && !liveApiNames.has(field)) {
    throw new UnprocessableEntityException(`unknown field "${field}" in filter`);
  }
}

/** Drops references to fields that no longer exist (defensive read, C-series ACs). */
export function cleanViewConfig(
  config: ViewConfig,
  liveFieldIds: Set<string>,
  liveApiNames: Set<string>,
): ViewConfig {
  return {
    filters: config.filters ? (cleanFilterNode(config.filters, liveApiNames) as ViewConfig['filters']) : undefined,
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

/**
 * Which fields a board can group by (MN-079). A column per value only makes sense
 * when a record has exactly one value: select, single user, and the single side of
 * a one-to-many relation. Multi-valued fields (multi_select, multi user, the many
 * side, many-to-many) would put one card in several columns, so a drag between
 * columns has no single meaning — they stay unsupported.
 *
 * `relation` is the row from the relations table for a relation field; null for
 * every other type. Returns an error message, or null when groupable.
 */
export function boardGroupError(
  field: { type: string; config: unknown } | undefined,
  relation: { cardinality: string } | null,
): string | null {
  if (!field) return 'board views require group_by_field_id';
  const config = (field.config ?? {}) as Record<string, unknown>;
  if (field.type === 'select') return null;
  if (field.type === 'user') {
    return config['multi'] === true
      ? 'board views cannot group by a multi-user field — a card would land in several columns'
      : null;
  }
  if (field.type === 'relation') {
    if (!relation) return 'the group-by relation no longer exists';
    const single = relation.cardinality === 'one_to_many' && config['side'] === 'a';
    return single
      ? null
      : 'board views can only group by the single side of a one-to-many relation — a many-to-many or the many side would put a card in several columns';
  }
  return `board views cannot group by a "${field.type}" field — use a select, a single user, or a one-to-many relation`;
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

    if (config.filters) assertFilterFieldsLive(config.filters, apiNames);
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
      let relation: { cardinality: string } | null = null;
      if (groupField?.type === 'relation') {
        const relationId = (groupField.config as Record<string, unknown>)['relation_id'];
        if (typeof relationId === 'string') {
          relation =
            (await this.db.query.relations.findFirst({ where: eq(relations.id, relationId) })) ??
            null;
        }
      }
      const error = boardGroupError(groupField, relation);
      if (error) throw new UnprocessableEntityException(error);
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

  /** Clone a view with its full config, named "<name> copy", next to the original (MN-241). */
  async duplicate(databaseId: string, viewId: string) {
    const source = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId)),
    });
    if (!source) throw new NotFoundException('View not found');

    // Place right after the source; shift later siblings down to make room.
    const siblings = await this.db.query.views.findMany({
      where: eq(views.databaseId, databaseId),
      columns: { id: true, position: true },
    });
    const target = source.position + 1;
    await Promise.all(
      siblings
        .filter((v) => v.position >= target)
        .map((v) =>
          this.db.update(views).set({ position: v.position + 1 }).where(eq(views.id, v.id)),
        ),
    );

    const [copy] = await this.db
      .insert(views)
      .values({
        databaseId,
        name: `${source.name} copy`,
        type: source.type,
        config: source.config,
        position: target,
        isDefault: false, // a copy is never the default
        createdBy: source.createdBy,
      })
      .returning();
    return copy!;
  }

  /** Make a view the database's default; exactly one default per database (MN-241). */
  async setDefault(databaseId: string, viewId: string) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId)),
    });
    if (!view) throw new NotFoundException('View not found');

    return this.db.transaction(async (tx) => {
      await tx
        .update(views)
        .set({ isDefault: false })
        .where(and(eq(views.databaseId, databaseId), eq(views.isDefault, true)));
      const [updated] = await tx
        .update(views)
        .set({ isDefault: true })
        .where(eq(views.id, viewId))
        .returning();
      return updated!;
    });
  }

  /** Every database keeps ≥1 view (C7). */
  async remove(databaseId: string, viewId: string) {
    const all = await this.db.query.views.findMany({ where: eq(views.databaseId, databaseId) });
    const removed = all.find((v) => v.id === viewId);
    if (!removed) throw new NotFoundException('View not found');
    if (all.length <= 1) throw new ConflictException('A database must keep at least one view');
    await this.db.delete(views).where(eq(views.id, viewId));
    // Keep exactly one default: if we removed the default, promote the first remaining view.
    if (removed.isDefault) {
      const next = all
        .filter((v) => v.id !== viewId)
        .sort((a, b) => a.position - b.position)[0]!;
      await this.db.update(views).set({ isDefault: true }).where(eq(views.id, next.id));
    }
    return { deleted: true };
  }
}
