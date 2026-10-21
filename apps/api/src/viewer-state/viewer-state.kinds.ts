import { NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { filterSchema, type FilterNode } from '@storyos/schemas';
import type { Db } from '../db/client';
import { databases, fields, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { assertFilterFieldsLive, cleanFilterNode } from '../views/views.service';

/**
 * ADR-0019 / #973 — the registry of per-viewer override KINDS. A kind is one entry here, not a new table, controller and ADR:
 *
 *   - `schema`    validates the stored `data`;
 *   - `resolve`   turns the shared object's id into the DATABASE it belongs to (and its workspace). Access to an override is access
 *                 to that database, checked the same way for every kind (`ViewerStateService.reach`: `viewer` on the database);
 *   - `validate`  optional write-time check against live state (a filter may only name fields that exist);
 *   - `present`   optional read-time cleaning (a filter naming a since-deleted field is pruned on the way out, never rewritten).
 */
export interface ResolvedTarget {
  databaseId: string;
  workspaceId: string;
}

export interface ViewerStateKind<T> {
  schema: z.ZodType<T>;
  resolve(db: Db, targetId: string): Promise<ResolvedTarget | null>;
  validate?(db: Db, target: ResolvedTarget, data: T): Promise<void>;
  present?(db: Db, target: ResolvedTarget, data: T): Promise<T | undefined>;
  /** What is missing when `resolve` finds nothing: the 404 says which kind of thing, as the endpoints always have. */
  missing: string;
}

const liveApiNames = async (db: Db, databaseId: string): Promise<Set<string>> =>
  new Set(
    (await db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)), columns: { apiName: true } })).map(
      (f) => f.apiName,
    ),
  );

/** A personal filter on a shared view (#259): `{ and|or: [...] }`, the same AST a view's own `filters` use. */
const viewFilter: ViewerStateKind<FilterNode> = {
  missing: 'View not found',
  schema: filterSchema as unknown as z.ZodType<FilterNode>,
  async resolve(db, viewId) {
    const row = await db
      .select({ databaseId: views.databaseId, workspaceId: databases.workspaceId })
      .from(views)
      .innerJoin(databases, eq(databases.id, views.databaseId))
      .where(and(eq(views.id, viewId), notDeleted(views.deletedAt)));
    const hit = row[0];
    return hit?.databaseId ? { databaseId: hit.databaseId, workspaceId: hit.workspaceId } : null;
  },
  async validate(db, target, filter) {
    assertFilterFieldsLive(filter, await liveApiNames(db, target.databaseId));
  },
  async present(db, target, filter) {
    return cleanFilterNode(filter, await liveApiNames(db, target.databaseId)) as FilterNode | undefined;
  },
};

const collectionViewConditionSchema = z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() });
/** A personal override of an embedded relation collection (#736): narrows / sorts / colours it for ONE viewer. */
export const collectionViewSchema = z.object({
  filters: z
    .union([z.object({ and: z.array(collectionViewConditionSchema) }), z.object({ or: z.array(collectionViewConditionSchema) })])
    .optional(),
  sorts: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) })).max(3).optional(),
  sorts_nulls: z.enum(['first', 'last']).optional(),
  color_by: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
export type CollectionViewData = z.infer<typeof collectionViewSchema>;

const collectionView: ViewerStateKind<CollectionViewData> = {
  missing: 'Relation field not found',
  schema: collectionViewSchema,
  async resolve(db, fieldId) {
    const row = await db
      .select({ databaseId: fields.databaseId, workspaceId: databases.workspaceId, type: fields.type })
      .from(fields)
      .innerJoin(databases, eq(databases.id, fields.databaseId))
      .where(and(eq(fields.id, fieldId), isNull(fields.deletedAt)));
    const hit = row[0];
    // only a relation field has an embedded collection to override
    return hit && hit.type === 'relation' ? { databaseId: hit.databaseId, workspaceId: hit.workspaceId } : null;
  },
};

/**
 * Pinned view tabs (ticket #966): which SHARED views of a database this person keeps in their tab strip, in their order. The target
 * is the database. Registered here so #966 only has to add its endpoint; there is no controller for it yet.
 */
export const pinnedTabsSchema = z.object({ view_ids: z.array(z.uuid()).max(50) });
export type PinnedTabsData = z.infer<typeof pinnedTabsSchema>;
const pinnedTabs: ViewerStateKind<PinnedTabsData> = {
  missing: 'Database not found',
  schema: pinnedTabsSchema,
  async resolve(db, databaseId) {
    const row = await db.query.databases.findFirst({ where: and(eq(databases.id, databaseId), notDeleted(databases.deletedAt)), columns: { id: true, workspaceId: true } });
    return row ? { databaseId: row.id, workspaceId: row.workspaceId } : null;
  },
  async validate(db, target, data) {
    const ids = new Set(data.view_ids);
    if (ids.size !== data.view_ids.length) throw new NotFoundException('A view is pinned twice');
    for (const viewId of ids) {
      const v = await db.query.views.findFirst({ where: and(eq(views.id, viewId), eq(views.databaseId, target.databaseId), notDeleted(views.deletedAt)), columns: { id: true, ownerUserId: true } });
      if (!v) throw new NotFoundException('View not found');
    }
  },
};

export const VIEWER_STATE_KINDS = {
  view_filter: viewFilter,
  collection_view: collectionView,
  pinned_tabs: pinnedTabs,
} as const;
export type ViewerStateKindName = keyof typeof VIEWER_STATE_KINDS;
export type ViewerStateData<K extends ViewerStateKindName> = z.infer<(typeof VIEWER_STATE_KINDS)[K]['schema']>;
