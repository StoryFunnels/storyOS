import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { filterSchema, type FilterNode } from '@storyos/schemas';
import type { Db } from '../db/client';
import { databases, fields, views, workspaces } from '../db/schema';
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
  /** The database access is checked against. Absent for a kind whose target is the workspace itself (`dismissed_hints`): the door is membership. */
  databaseId?: string;
  workspaceId: string;
}

export interface ViewerStateKind<T> {
  schema: z.ZodType<T>;
  resolve(db: Db, targetId: string): Promise<ResolvedTarget | null>;
  validate?(db: Db, target: ResolvedTarget, data: T, userId: string): Promise<void>;
  present?(db: Db, target: ResolvedTarget, data: T, userId: string): Promise<T | undefined>;
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
    assertFilterFieldsLive(filter, await liveApiNames(db, target.databaseId!));
  },
  async present(db, target, filter) {
    return cleanFilterNode(filter, await liveApiNames(db, target.databaseId!)) as FilterNode | undefined;
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
 * Pinned view tabs (ticket #966 / #986): which views of a database this person keeps in their tab strip, in their order. The target
 * is the database.
 *
 * A pin may name a SHARED view of that database, or the person's OWN personal view; someone else's personal view is "not found", the
 * same answer as a view that does not exist, so a pin can never confirm that a private view exists. On READ the list is cleaned against
 * live state — a view trashed or deleted since, or one this person can no longer see, drops out of the answer without rewriting the
 * stored row (the same rule `view_filter` follows for a deleted field), so a stale id never reaches the tab strip.
 */
export const pinnedTabsSchema = z.object({ view_ids: z.array(z.uuid()).max(50) });
export type PinnedTabsData = z.infer<typeof pinnedTabsSchema>;
const visibleViewIds = async (db: Db, databaseId: string, userId: string, ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await db.query.views.findMany({
    where: and(eq(views.databaseId, databaseId), inArray(views.id, ids), notDeleted(views.deletedAt)),
    columns: { id: true, ownerUserId: true },
  });
  return new Set(rows.filter((v) => !v.ownerUserId || v.ownerUserId === userId).map((v) => v.id));
};
const pinnedTabs: ViewerStateKind<PinnedTabsData> = {
  missing: 'Database not found',
  schema: pinnedTabsSchema,
  async resolve(db, databaseId) {
    const row = await db.query.databases.findFirst({ where: and(eq(databases.id, databaseId), notDeleted(databases.deletedAt)), columns: { id: true, workspaceId: true } });
    return row ? { databaseId: row.id, workspaceId: row.workspaceId } : null;
  },
  async validate(db, target, data, userId) {
    const ids = new Set(data.view_ids);
    if (ids.size !== data.view_ids.length) throw new UnprocessableEntityException('A view is pinned twice');
    const visible = await visibleViewIds(db, target.databaseId!, userId, [...ids]);
    if (visible.size !== ids.size) throw new NotFoundException('View not found');
  },
  async present(db, target, data, userId) {
    const visible = await visibleViewIds(db, target.databaseId!, userId, data.view_ids);
    return { view_ids: data.view_ids.filter((id) => visible.has(id)) };
  },
};

/**
 * Dismissed hints (ticket #986, for #976): which one-time cards ("hints") this person hid in this workspace. The target is the
 * WORKSPACE itself, so there is no database to check access against — being a member is the door, and `reach` has already required the
 * target to be the caller's own workspace. A hint id is a short stable key the client chooses ("agent-runs-explainer"); the server
 * does not enumerate them, so a later card needs no API change.
 */
export const dismissedHintsSchema = z.object({
  hint_ids: z.array(z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/i, 'A hint id is letters, digits and . _ : -')).max(200),
});
export type DismissedHintsData = z.infer<typeof dismissedHintsSchema>;
const dismissedHints: ViewerStateKind<DismissedHintsData> = {
  missing: 'Workspace not found',
  schema: dismissedHintsSchema,
  async resolve(db, workspaceId) {
    const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { id: true } });
    return row ? { workspaceId: row.id } : null;
  },
  async validate(_db, _target, data) {
    if (new Set(data.hint_ids).size !== data.hint_ids.length) throw new UnprocessableEntityException('A hint is listed twice');
  },
};

export const VIEWER_STATE_KINDS = {
  view_filter: viewFilter,
  collection_view: collectionView,
  pinned_tabs: pinnedTabs,
  dismissed_hints: dismissedHints,
} as const;
export type ViewerStateKindName = keyof typeof VIEWER_STATE_KINDS;
export type ViewerStateData<K extends ViewerStateKindName> = z.infer<(typeof VIEWER_STATE_KINDS)[K]['schema']>;
