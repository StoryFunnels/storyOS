import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { ViewConfig, ViewType } from '@storyos/schemas';
import { SYSTEM_FIELDS } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, relations, spaceFolders, views } from '../db/schema';

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
    // MN-252: whole-sort empty-values placement rides alongside `sorts`.
    sorts_nulls: config.sorts_nulls,
    hidden_field_ids: (config.hidden_field_ids ?? []).filter((id) => liveFieldIds.has(id)),
    group_by_field_id:
      config.group_by_field_id && liveFieldIds.has(config.group_by_field_id)
        ? config.group_by_field_id
        : undefined,
    // #307 — rides alongside group_by_field_id (period per column for a date board).
    group_by_granularity: config.group_by_granularity,
    color_by_field_id:
      config.color_by_field_id && liveFieldIds.has(config.color_by_field_id)
        ? config.color_by_field_id
        : undefined,
    card_field_ids: (config.card_field_ids ?? []).filter((id) => liveFieldIds.has(id)),
    /*
     * #391 — the gallery's cover field, dropped when it no longer exists.
     *
     * This function rebuilds the config EXPLICITLY rather than spreading, which
     * is what makes it a defensive read — and it is also why a new key that is
     * not listed here is silently stripped on the way out. `cover_field_id`
     * persisted correctly and came back missing until this line existed, so the
     * picker read "None" over a config that plainly said otherwise.
     *
     * A DANGLING id is dropped; an unset one stays unset. That distinction is
     * #305's lesson — conflating "not configured" with "invalid" is what deleted
     * users' dashboard tiles.
     */
    cover_field_id:
      config.cover_field_id && liveFieldIds.has(config.cover_field_id)
        ? config.cover_field_id
        : undefined,
    card_size: config.card_size,
    /*
     * #427 / #428 — board column order and the two empty-group toggles.
     *
     * Listed here for the reason the comments above and below both spell out:
     * this function is an explicit allowlist, and an unlisted key saves fine and
     * then vanishes on every read. That has now cost #227 and #391; these are
     * pure preferences naming no field id, so they pass through unconditionally.
     */
    column_sort: config.column_sort,
    hide_empty_groups: config.hide_empty_groups,
    hide_empty_no_value_group: config.hide_empty_no_value_group,
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
    // #227 — the timeline's baseline (planned) pair, pruned by the SAME rule as the
    // primary pair: dropped only when the field it names is gone. Omitting these
    // here is what made #227 look broken end to end — the keys saved to the database
    // correctly and then vanished on every read, because this function is an
    // explicit allowlist and anything unlisted is silently discarded.
    baseline_start_date_field_id:
      config.baseline_start_date_field_id && liveFieldIds.has(config.baseline_start_date_field_id)
        ? config.baseline_start_date_field_id
        : undefined,
    baseline_end_date_field_id:
      config.baseline_end_date_field_id && liveFieldIds.has(config.baseline_end_date_field_id)
        ? config.baseline_end_date_field_id
        : undefined,
    form: config.form,
    /**
     * #559 — `share` (#264/#536) was added to ViewConfig after this function's
     * explicit key list was written, and fell into the exact trap the comments
     * throughout this function already name: a key not listed here is silently
     * stripped on every read, so a published view read back "Not published"
     * forever, even though the stored row and the public /v/:token page (which
     * reads the row directly, bypassing this function) were both correct.
     *
     * Passed through UNCONDITIONALLY, same as `form` immediately above — both
     * are minted/cleared ONLY through their own dedicated write path
     * (POST/DELETE .../share, never the ordinary view PATCH), which already
     * validates `visible_field_api_names`/`include_relation_api_names` against
     * live fields at write time (ViewsService.share). Re-validating those
     * allowlists again here, against fields that may have changed since
     * publish, is a real future edge case (a field named in an already-published
     * allowlist gets deleted) but is a DIFFERENT question from this ticket's
     * "the read path drops a key the write path stored correctly" bug — and
     * `form` sets the precedent of not doing that revalidation on every read
     * either.
     */
    share: config.share,
    // Dashboard tiles (MN-225 / #168): drop a tile that POINTS AT a field which
    // no longer exists — never one that simply hasn't been pointed anywhere yet.
    // #305: this used to require `field_api_name` for any non-count op, so
    // switching a tile Count→Sum (or adding one on a database with no number
    // field) produced `{op:'sum'}` with no field, and the tile was silently
    // garbage-collected on the very next read — the card "deleted itself".
    // "Unconfigured" and "dangling" are different states; only the latter is junk.
    dashboard_tiles: (config.dashboard_tiles ?? [])
      // #304: a tile that names its OWN source database is measured against THAT
      // database's fields, and this function only knows the view's. Pruning it
      // here would delete a perfectly valid cross-database tile the moment its
      // field name happened not to exist on the view's database — the #305 defect
      // wearing a different hat. Such a tile is passed through untouched; its own
      // database's schema is the only thing entitled to invalidate it.
      .filter((t) => t.database_id != null || t.field_api_name == null || liveApiNames.has(t.field_api_name))
      // A tile's own filter gets the same pruning the view's filter gets — a
      // condition on a deleted field is dropped rather than left to fail at query
      // time. The TILE itself survives (it is still configured); only the dead
      // condition goes, exactly as cleanFilterNode does for the view. Same
      // cross-database exemption applies.
      .map((t) =>
        t.filter && t.database_id == null
          ? { ...t, filter: cleanFilterNode(t.filter, liveApiNames) as typeof t.filter }
          : t,
      ),
    // Dashboard chart/table widgets (MN-225 / #168, Phase 2): same rule.
    // #305: requiring a live `group_by_field_api_name` meant a freshly added
    // chart (created with no group-by, by design — you pick it afterwards) was
    // stripped before the user could ever configure it, so "Add chart" could
    // never stick. Drop only fields that are NAMED and missing.
    dashboard_widgets: (config.dashboard_widgets ?? [])
      // #367: the same cross-database exemption tiles got in #304, and it must
      // stay just as NARROW. This function only ever knows the VIEW's fields, so
      // a widget measuring another database would have its perfectly valid
      // group-by pruned the moment that api_name happened not to exist here. A
      // widget with no database_id is still the view's own and is still pruned.
      .filter(
        (w) =>
          w.database_id != null ||
          ((w.group_by_field_api_name == null || liveApiNames.has(w.group_by_field_api_name)) &&
            (w.measure.field_api_name == null || liveApiNames.has(w.measure.field_api_name))),
      )
      // A widget's own filter gets the same pruning the view's filter gets — a
      // condition on a deleted field is dropped rather than left to fail at query
      // time. The WIDGET survives (it is still configured); only the dead
      // condition goes. Same cross-database exemption.
      .map((w) =>
        w.filter && w.database_id == null
          ? { ...w, filter: cleanFilterNode(w.filter, liveApiNames) as typeof w.filter }
          : w,
      ),
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
  // #172: a workflow (status) field groups a board exactly like single-select.
  if (field.type === 'select' || field.type === 'workflow') return null;
  // #307: a date field groups into periods (week/month/quarter/year). Still exactly
  // one column per record, so the single-valued rule this function enforces holds.
  if (field.type === 'date') return null;
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
  // #498 — bins turn an otherwise-continuous number into single-valued buckets,
  // same as a date's period does; unconfigured (no bins yet) stays refused
  // rather than silently offering an unbounded, column-per-value board.
  if (field.type === 'number') {
    const bins = config['bins'];
    return Array.isArray(bins) && bins.length > 0
      ? null
      : 'configure bins on this field before grouping a board by it';
  }
  // #499 — text and lookup are single-valued (one column per record), so the
  // "would land in several columns" rule this function otherwise enforces does
  // not rule them out. They ARE read-only for grouping though — see
  // `boardGroupIsReadOnly` — so a card lands in a column but a drag can never
  // change which one; that half is enforced by records.service.ts's `move()`.
  if (field.type === 'text' || field.type === 'lookup') return null;
  return `board views cannot group by a "${field.type}" field — use a select, a single user, or a one-to-many relation`;
}

/**
 * #499 — the single classification of "this board is grouped by something a
 * drag can never write back to," shared by the client's non-draggable marking
 * (`groupable-fields.ts`) and the server's write-guard on `move()`
 * (`records.service.ts`) so the two can never drift the way #267/#272 did.
 * Lookup is already refused by record-values.ts's general write validator
 * (computed, never writable anywhere) — listed here too for defense in depth
 * and so callers don't need to know that's a separate mechanism.
 */
export function boardGroupIsReadOnly(fieldType: string): boolean {
  return fieldType === 'text' || fieldType === 'lookup';
}

/**
 * #181: a Board view for a database that has a `workflow` (status) field defaults
 * to grouping by that field — the DB's canonical status is the obvious column axis.
 * Only fills an ABSENT `group_by_field_id`; an explicit choice (or any non-board
 * view) passes through untouched, so a user's pick is never overridden. Kept pure
 * so the default is unit-tested without a DB.
 */
export function defaultBoardGroupBy(
  type: ViewType,
  config: ViewConfig,
  liveFields: Array<{ id: string; type: string }>,
): ViewConfig {
  if (type !== 'board' || config.group_by_field_id) return config;
  const workflow = liveFields.find((f) => f.type === 'workflow');
  return workflow ? { ...config, group_by_field_id: workflow.id } : config;
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
    // #351: system fields (number, updated_by, …) are valid filter/sort references
    // in a saved view even when they have no stored field row — the query engine
    // resolves them via the same registry. Enumerated from the ONE canonical source.
    const apiNames = new Set([...live.map((f) => f.apiName), ...SYSTEM_FIELDS.map((f) => f.api_name)]);

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

  /**
   * #347 — a view may only be placed in a folder of ITS OWN space.
   *
   * Without this, a folder id from another space would put the view in a sidebar
   * it does not belong to: the tree would render it under a space whose grants
   * were never checked for it, and `space_folders.folderId` has no constraint
   * that would catch it. `undefined` means "not being changed"; `null` means
   * "move back under the database", and both are legitimate.
   */
  private async assertFolderInSameSpace(databaseId: string, folderId: string | null | undefined) {
    if (folderId === undefined || folderId === null) return;
    const database = await this.db.query.databases.findFirst({
      where: eq(databases.id, databaseId),
      columns: { spaceId: true },
    });
    const folder = await this.db.query.spaceFolders.findFirst({
      where: eq(spaceFolders.id, folderId),
      columns: { spaceId: true },
    });
    if (!folder) throw new NotFoundException('Folder not found');
    if (!database || folder.spaceId !== database.spaceId) {
      throw new UnprocessableEntityException(
        "A view can only be placed in a folder of its own database's space.",
      );
    }
  }

  async create(
    databaseId: string,
    input: { name: string; type: ViewType; config: ViewConfig; folder_id?: string | null },
    createdBy: string,
    /**
     * #520 — set only by createPersonal(). A personal view is a private
     * WINDOW onto this database's shared data (schema.ts's own note on
     * `ownerUserId`, mirroring personal-space.md §"Deleting through a
     * personal view") — it still needs a databaseId like any other view,
     * just flagged private, never folder-placed (no shared folder tree of
     * its own to belong to).
     */
    ownerUserId?: string,
  ) {
    if (ownerUserId) {
      if (input.folder_id) throw new UnprocessableEntityException('A personal view cannot be placed in a folder.');
    } else {
      await this.assertFolderInSameSpace(databaseId, input.folder_id);
    }
    // #181: default a Board's group-by to the database's workflow field when one
    // exists and the caller didn't pick one (validation then runs on the result).
    const live = await this.liveFields(databaseId);
    const config = defaultBoardGroupBy(input.type, input.config, live);
    await this.validateConfig(databaseId, input.type, config);
    const siblings = await this.db.query.views.findMany({
      where: and(eq(views.databaseId, databaseId), isNull(views.deletedAt)),
      columns: { position: true },
    });
    const [view] = await this.db
      .insert(views)
      .values({
        databaseId,
        folderId: ownerUserId ? null : (input.folder_id ?? null),
        name: input.name,
        type: input.type,
        config,
        position: Math.max(-1, ...siblings.map((v) => v.position)) + 1,
        createdBy,
        ownerUserId,
      })
      .returning();
    return view!;
  }

  /**
   * #520 — create a view owned by the caller rather than shared. `createdBy`
   * and `ownerUserId` are the same person: authorship and privacy happen to
   * coincide for a personal view, but they're separate columns (createdBy is
   * never a privacy signal — see the column's own doc comment in schema.ts).
   */
  async createPersonal(
    databaseId: string,
    input: { name: string; type: ViewType; config: ViewConfig },
    ownerUserId: string,
  ) {
    return this.create(databaseId, input, ownerUserId, ownerUserId);
  }

  async update(
    databaseId: string,
    viewId: string,
    patch: { name?: string; config?: ViewConfig; position?: number; folder_id?: string | null },
  ) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
    });
    if (!view) throw new NotFoundException('View not found');
    if (patch.config) await this.validateConfig(databaseId, view.type, patch.config);
    await this.assertFolderInSameSpace(databaseId, patch.folder_id);

    // #264 — `share` is service-owned (minted/cleared only by ViewsService's
    // own `share`/`unshare`, never accepted from a client body — see the
    // schema's own comment). `config` here REPLACES the row wholesale, so an
    // ordinary filter/sort edit through today's UI — which knows nothing
    // about `share` — would otherwise silently unpublish a shared view the
    // moment anything else about it changed. Carried forward regardless of
    // what `patch.config` contains.
    const config = patch.config
      ? { ...patch.config, share: (view.config as ViewConfig | null)?.share }
      : patch.config;

    const [updated] = await this.db
      .update(views)
      .set({
        name: patch.name,
        config,
        position: patch.position,
        // #347: `undefined` leaves placement alone (drizzle skips it); an explicit
        // `null` moves the view back under its database. The two must stay
        // distinguishable, so this cannot collapse to `patch.folder_id ?? null`.
        ...(patch.folder_id !== undefined ? { folderId: patch.folder_id } : {}),
      })
      .where(eq(views.id, viewId))
      .returning();
    return updated!;
  }

  /** Clone a view with its full config, named "<name> copy", next to the original (MN-241). */
  async duplicate(databaseId: string, viewId: string) {
    const source = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
    });
    if (!source) throw new NotFoundException('View not found');

    // Place right after the source; shift later siblings down to make room.
    const siblings = await this.db.query.views.findMany({
      where: and(eq(views.databaseId, databaseId), isNull(views.deletedAt)),
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
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
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

  /**
   * #567 — the access level DELETE .../views/:view must require. A personal
   * view (`ownerUserId` set) deleted by its OWNER needs only viewer access on
   * the database, matching what `createPersonal` already requires to make
   * one — a viewer-only member who made their own private lens must be able
   * to remove it without needing an editor to do it for them, which would
   * defeat the point of it being private. Every other case (a shared view,
   * or a personal view someone other than its owner is somehow trying to
   * delete) is unchanged: editor.
   */
  async deleteAccessLevel(databaseId: string, viewId: string, callerId: string): Promise<'viewer' | 'editor'> {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
      columns: { ownerUserId: true },
    });
    if (!view) throw new NotFoundException('View not found');
    return view.ownerUserId === callerId ? 'viewer' : 'editor';
  }

  /**
   * Every database keeps ≥1 SHARED view (C7). #453: soft-deletes rather than
   * removing the row.
   *
   * #567 — "at least one view" is a promise about the database staying
   * browsable for everyone, i.e. at least one SHARED view; a personal view
   * is invisible to everyone but its owner (ADR-0017/#291) and was never
   * part of that promise, so deleting one is never blocked by this count,
   * and it is never a candidate for default-promotion below either.
   */
  async remove(databaseId: string, viewId: string) {
    const all = await this.db.query.views.findMany({
      where: and(eq(views.databaseId, databaseId), isNull(views.deletedAt)),
    });
    const removed = all.find((v) => v.id === viewId);
    if (!removed) throw new NotFoundException('View not found');
    if (!removed.ownerUserId) {
      const sharedCount = all.filter((v) => !v.ownerUserId).length;
      if (sharedCount <= 1) throw new ConflictException('A database must keep at least one view');
    }
    await this.db.update(views).set({ deletedAt: new Date() }).where(eq(views.id, viewId));
    // Keep exactly one default: if we removed the default, promote the first remaining SHARED view.
    if (removed.isDefault) {
      const next = all
        .filter((v) => v.id !== viewId && !v.ownerUserId)
        .sort((a, b) => a.position - b.position)[0];
      if (next) await this.db.update(views).set({ isDefault: true }).where(eq(views.id, next.id));
    }
    return { deleted: true };
  }

  /**
   * #264 — publish (or re-configure) a view's public read-only link. Idempotent
   * on the token: re-sharing an already-published view keeps the SAME token
   * (a share dialog editing the allowlist must not invalidate a link someone
   * already has) and just updates the allowlist/indexing.
   *
   * Only a database-owned view can be published — a dashboard (#306, no
   * `databaseId`) has no single set of records or fields to allowlist, and
   * "records via the view's own filter+sorts" (this ticket's whole mechanism)
   * presupposes exactly one.
   */
  async share(
    databaseId: string,
    viewId: string,
    input: { visible_field_api_names?: string[]; include_relation_api_names?: string[]; indexable?: boolean },
  ): Promise<{ token: string }> {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
    });
    if (!view) throw new NotFoundException('View not found');
    // #554 — a personal view (ownerUserId set) can NEVER be published, by
    // anyone, including its own owner: personal space's whole premise
    // (ADR-0017/#291) is invisibility to everyone else, and a public
    // anonymous URL is a categorically stronger exposure than "visible only
    // to me" — undermining the feature's promise even when the owner does it
    // themselves. 404, not 403: a personal view is already invisible to
    // everyone but its owner everywhere else in this codebase (it never
    // appears in another member's view list), so this endpoint treats it the
    // same way rather than confirming a personal view exists at this id.
    if (view.ownerUserId) throw new NotFoundException('View not found');

    const live = await this.liveFields(databaseId);
    const liveApiNames = new Set(live.map((f) => f.apiName));
    for (const name of input.visible_field_api_names ?? []) {
      if (!liveApiNames.has(name)) {
        throw new UnprocessableEntityException(`unknown field "${name}" in visible_field_api_names`);
      }
    }
    const relationApiNames = new Set(live.filter((f) => f.type === 'relation').map((f) => f.apiName));
    for (const name of input.include_relation_api_names ?? []) {
      if (!relationApiNames.has(name)) {
        throw new UnprocessableEntityException(`"${name}" is not a relation field on this database`);
      }
    }

    const currentConfig = (view.config ?? {}) as ViewConfig;
    const token = currentConfig.share?.public_token ?? randomBytes(24).toString('base64url');
    const share = {
      public_token: token,
      visible_field_api_names: input.visible_field_api_names,
      include_relation_api_names: input.include_relation_api_names ?? [],
      indexable: input.indexable ?? false,
    };
    await this.db.update(views).set({ config: { ...currentConfig, share } }).where(eq(views.id, viewId));
    return { token };
  }

  /** #264 — revoke: the token stops resolving immediately (no cache, no grace window). */
  async unshare(databaseId: string, viewId: string): Promise<{ unshared: true }> {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), isNull(views.deletedAt)),
    });
    if (!view) throw new NotFoundException('View not found');
    // #554 — deliberately NOT gated on ownerUserId, unlike share() above:
    // revoking is the safe direction (it only REMOVES exposure), and a
    // personal view published before this fix shipped (or by some future
    // bug) must stay revocable through the normal API rather than becoming
    // permanently stuck — the ticket's own rollout step needs exactly this.
    const config = { ...(view.config as ViewConfig) };
    delete config.share;
    await this.db.update(views).set({ config }).where(eq(views.id, viewId));
    return { unshared: true };
  }
}
