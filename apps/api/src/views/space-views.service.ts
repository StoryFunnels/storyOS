import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AgentDeleteHoldService } from '../action-gates/agent-delete-hold.service';
import { recordStructuralEvent } from '../activity/structural-events';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, spaceFolders, spaces, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { ACCESS_RANK, AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { viewConfigSchema, type ViewConfig } from '@storyos/schemas';
import { ViewsService } from './views.service';

/**
 * #1013 — the databases a view NAMES as its sources, before any access check: an ordinary view reads its own database; a dashboard
 * reads its own database (when it has one) and every database a tile or widget names with `database_id`. A tile or widget with none
 * reads the view's own database (or, on a space-level dashboard, is unconfigured and reads nothing yet). First-appearance order, own
 * database first, no repeats.
 */
function namedSources(v: { databaseId: string | null; type: string; config: unknown }): string[] {
  const out: string[] = v.databaseId ? [v.databaseId] : [];
  if (v.type === 'dashboard') {
    const cfg = (v.config ?? {}) as { dashboard_tiles?: Array<{ database_id?: string }>; dashboard_widgets?: Array<{ database_id?: string }> };
    for (const block of [...(cfg.dashboard_tiles ?? []), ...(cfg.dashboard_widgets ?? [])]) {
      if (typeof block?.database_id === 'string') out.push(block.database_id);
    }
  }
  return [...new Set(out)];
}

/**
 * #347 — every view a member can navigate to inside ONE space, for the sidebar tree.
 *
 * This endpoint exists because there was no way to ask "what views are in this
 * space". Views were reachable only per database (`GET /databases/:db` /
 * `describe_database`), so a sidebar rendering them would issue one request per
 * database per space — the N+1 that makes the feature not worth having.
 *
 * A view is in a space if EITHER its database is (the ordinary case, every view
 * today) OR it names the space directly (a dashboard, #306). That is the
 * `views_owner_xor` invariant read from the other end.
 */
@Injectable()
export class SpaceViewsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly viewsService: ViewsService,
    /** #1178 — the agent's own `delete` approval_policy, applied to a run credential's space-view delete. */
    private readonly agentDeletes: AgentDeleteHoldService,
  ) {}

  onModuleInit(): void {
    // #1178 — an approved space-view delete runs as the acting member (the space door and edit access are re-checked by removeById).
    this.agentDeletes.registerApplier('space_view', async ({ membership, params }) => {
      const viewId = params['view_id'] as string | undefined;
      if (!viewId) throw new UnprocessableEntityException('This held delete names no view; nothing was deleted');
      await this.removeById(membership, viewId);
    });
  }

  async listForSpace(membership: Membership, spaceId: string) {
    /**
     * The space is the door (ADR §6) — but the door is `visibleSpaceIds`, NOT
     * `assertSpace`, and the difference is load-bearing.
     *
     * `assertSpace` → `effectiveForSpace` matches only SPACE-scoped grants. A
     * guest granted a single DATABASE therefore fails it, while
     * `visibleSpaceIds` puts that same space in their sidebar (it adds the
     * parent space of every database-scoped grant). Using assertSpace here 404s
     * a space the user is looking at — verified by test, and the reason this
     * comment exists rather than the obvious one-liner.
     *
     * So: can they see the space AT ALL, then let the per-database filter below
     * decide what is actually in it.
     */
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, membership.workspaceId), notDeleted(spaces.deletedAt)),
      columns: { id: true, personal: true, ownerUserId: true },
    });
    // 404 rather than an empty list: never confirm a space exists to someone who
    // cannot see it. Same choice assertSpace makes everywhere else.
    if (!space) throw new NotFoundException('Space not found');
    // #291 — another member's personal space, admins included. No bypass.
    if (!this.access.canSeePersonal(membership, space)) throw new NotFoundException('Space not found');
    const visible = await this.access.visibleSpaceIds(membership);
    if (visible !== null && !visible.has(spaceId)) throw new NotFoundException('Space not found');

    const dbRows = await this.db.query.databases.findMany({
      where: and(
        eq(databases.spaceId, spaceId),
        eq(databases.workspaceId, membership.workspaceId),
        notDeleted(databases.deletedAt),
      ),
      columns: { id: true, spaceId: true },
    });
    const dbIds = dbRows.map((d) => d.id);

    const rows = await this.db.query.views.findMany({
      where: and(
        dbIds.length > 0
          ? or(inArray(views.databaseId, dbIds), eq(views.spaceId, spaceId))
          : eq(views.spaceId, spaceId),
        // #291 — shared views plus this member's own personal ones. A personal
        // view placed in a folder is still personal, so this must be applied
        // here and not only on the database page.
        this.access.notOthersPersonalView(membership),
        notDeleted(views.deletedAt),
      ),
      orderBy: [asc(views.position), asc(views.createdAt)],
    });

    // Each source is a room (ADR §6): resolve the view's database against the
    // VIEWER, and drop what they cannot read. Only GUESTS can fail this —
    // effectiveForDatabase returns admin/creator for admins and members without
    // consulting grants at all (ADR-0009) — so the common path costs nothing,
    // and the guest path is the one a test has to exercise.
    //
    // Resolved once per DATABASE rather than once per view: a space with 20
    // views over 5 databases asks 5 questions, not 20.
    const readable = new Set<string>();
    for (const database of dbRows) {
      const role = await this.access.effectiveForDatabase(membership, database);
      if (role) readable.add(database.id);
    }

    const shown = rows.filter((v) => v.databaseId === null || readable.has(v.databaseId));

    // #1013 — each view's SOURCE databases, in one batched pass: gather every database any shown view names, resolve them with ONE
    // query, and ask the access question once per DISTINCT database (a dashboard may read a database outside this space, so the
    // `readable` set above is not enough). No per-view and no per-dashboard fetch.
    const named = new Map<string, string[]>(shown.map((v) => [v.id, namedSources(v)]));
    const wanted = [...new Set([...named.values()].flat())];
    const sourceDbs = wanted.length
      ? await this.db.query.databases.findMany({
          where: and(inArray(databases.id, wanted), eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
          columns: { id: true, spaceId: true },
        })
      : [];
    const sourceReadable = new Set<string>();
    for (const database of sourceDbs) {
      if (readable.has(database.id) || (await this.access.effectiveForDatabase(membership, database))) sourceReadable.add(database.id);
    }

    return shown.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      database_id: v.databaseId,
      space_id: v.spaceId,
      folder_id: v.folderId,
      position: v.position,
      is_default: v.isDefault,
      /** #291 — the sidebar badges a personal view; it never exposes whose. */
      personal: v.ownerUserId !== null,
      /**
       * #1013 — the databases this view reads: its own database for an ordinary view; for a dashboard, its own database (if it has one)
       * plus every database its tiles and widgets name. Databases the caller cannot read are OMITTED, never listed.
       */
      source_database_ids: (named.get(v.id) ?? []).filter((id) => sourceReadable.has(id)),
    }));
  }

  /**
   * #551 — every PERSONAL view the caller owns, across the whole workspace,
   * for the Personal sidebar section (#292): a personal view is only ever
   * database-owned (schema.ts's own note on `ownerUserId` — it never gets
   * `spaceId`), so unlike `listForSpace` there is no dashboard/null-database
   * case to carry along.
   *
   * Scoped to `ownerUserId` directly rather than `notOthersPersonalView` —
   * that predicate answers "not someone ELSE's", which still admits every
   * shared view; this answers "mine", the narrower question this endpoint
   * actually asks.
   */
  async listPersonal(membership: Membership) {
    const rows = await this.db.query.views.findMany({
      where: and(eq(views.ownerUserId, membership.userId), notDeleted(views.deletedAt)),
      orderBy: [desc(views.createdAt)],
    });
    if (rows.length === 0) return [];

    // Scoped to THIS workspace's databases — ownerUserId is a global user id,
    // not per-workspace, so a personal view living in a different workspace
    // must never leak in here just because the same person owns it there too.
    const dbIds = [...new Set(rows.map((v) => v.databaseId).filter((id): id is string => id !== null))];
    const dbRows = await this.db.query.databases.findMany({
      where: and(
        inArray(databases.id, dbIds),
        eq(databases.workspaceId, membership.workspaceId),
        notDeleted(databases.deletedAt),
      ),
      columns: { id: true, name: true, spaceId: true },
    });
    const dbById = new Map(dbRows.map((d) => [d.id, d]));

    // AC3 — a personal view over a database the caller has since lost access
    // to is EXCLUDED, not flagged: the same "never confirm what you can't see"
    // rule `listForSpace` already applies to a space, applied here to a
    // database. Only a guest can actually fail this (effectiveForDatabase
    // never consults grants for an admin/member — ADR-0009).
    const readable = new Set<string>();
    for (const database of dbRows) {
      const role = await this.access.effectiveForDatabase(membership, database);
      if (role) readable.add(database.id);
    }

    return rows
      .filter((v) => v.databaseId !== null && readable.has(v.databaseId))
      .map((v) => {
        const database = dbById.get(v.databaseId!)!;
        return {
          id: v.id,
          name: v.name,
          type: v.type,
          database_id: database.id,
          database_name: database.name,
        };
      });
  }

  /**
   * ticket #1101 — the door for a route keyed by the VIEW's id (`/views/:view`). A space the caller cannot see answers exactly as a view
   * that does not exist ("View not found"), not "Space not found", which says there is a view in a space that exists. Space-keyed routes
   * (`/spaces/:space/views`) keep "Space not found": there the space IS the id the caller sent. test/restricted-404-id-only-sweep.test.ts.
   */
  private async assertViewSpaceDoor(membership: Membership, spaceId: string) {
    try {
      return await this.access.assertSpaceDoor(membership, spaceId);
    } catch (e) {
      if (e instanceof NotFoundException) throw new NotFoundException('View not found');
      throw e;
    }
  }

  /**
   * #306 — the same door as `listForSpace`, factored out so create/get/move
   * cannot drift from list. Returns the space row once the viewer is cleared.
   */
  private async assertVisibleSpace(membership: Membership, spaceId: string) {
    // #940: the door check lives in AccessService now (folders needed the same one); this stays as the local name.
    return this.access.assertSpaceDoor(membership, spaceId);
  }

  /**
   * #306 — create a view that lives in a SPACE and owns no database.
   *
   * Only a dashboard, in v1. Every other view type renders rows OF something, so
   * a table or board with no database is a view of nothing — accepting one would
   * create rows that no surface can draw. A dashboard composes independent
   * queries, which is exactly why it never fitted inside one database (#304).
   */
  async createForSpace(
    membership: Membership,
    spaceId: string,
    input: { name: string; type: string; folder_id?: string | null },
    createdBy: string,
  ) {
    await this.assertVisibleSpace(membership, spaceId);
    // Space-level views are content, not schema — same rank views need elsewhere.
    await this.access.assertSpace(membership, spaceId, 'editor').catch(() => {
      throw new ForbiddenException('You need edit access to this space.');
    });
    if (input.type !== 'dashboard') {
      throw new UnprocessableEntityException(
        `A space-level view must be a dashboard. "${input.type}" renders rows of a database, so it needs one — create it on the database instead.`,
      );
    }
    if (input.folder_id) await this.assertFolderInSpace(spaceId, input.folder_id);

    const [last] = await this.db
      .select({ position: views.position })
      .from(views)
      .where(eq(views.spaceId, spaceId))
      .orderBy(desc(views.position))
      .limit(1);

    const [row] = await this.db
      .insert(views)
      .values({
        // databaseId deliberately absent — views_owner_xor enforces exactly one,
        // and this is the space side of it.
        spaceId,
        folderId: input.folder_id ?? null,
        name: input.name,
        type: 'dashboard',
        config: {},
        position: (last?.position ?? -1) + 1,
        createdBy,
      })
      .returning();
    return row!;
  }

  /** #306 — a folder must belong to the space the view lives in. */
  private async assertFolderInSpace(spaceId: string, folderId: string) {
    const folder = await this.db.query.spaceFolders.findFirst({
      where: eq(spaceFolders.id, folderId),
      columns: { spaceId: true },
    });
    if (!folder) throw new NotFoundException('Folder not found');
    if (folder.spaceId !== spaceId) {
      throw new UnprocessableEntityException('That folder belongs to a different space.');
    }
  }

  /**
   * #306 — read one view by id, for the view-first route a database-less view
   * needs. A view WITH a database keeps its existing /databases/:db path; this
   * resolves either, so one route can serve both and no URL had to change.
   */
  async getById(membership: Membership, viewId: string) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), notDeleted(views.deletedAt)),
    });
    if (!view) throw new NotFoundException('View not found');
    // #291 — another member's personal view is not merely hidden from lists.
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }
    if (view.spaceId) {
      await this.assertViewSpaceDoor(membership, view.spaceId);
    } else if (view.databaseId) {
      const database = await this.db.query.databases.findFirst({
        where: and(
          eq(databases.id, view.databaseId),
          eq(databases.workspaceId, membership.workspaceId),
          notDeleted(databases.deletedAt),
        ),
        columns: { id: true, spaceId: true },
      });
      if (!database) throw new NotFoundException('View not found');
      if (!(await this.access.effectiveForDatabase(membership, database))) {
        throw new NotFoundException('View not found');
      }
    }
    return {
      id: view.id,
      name: view.name,
      type: view.type,
      config: view.config,
      database_id: view.databaseId,
      space_id: view.spaceId,
      folder_id: view.folderId,
      is_default: view.isDefault,
      personal: view.ownerUserId !== null,
    };
  }

  /**
   * #945 — a view that lives on a DATABASE is behind that database's door, not just its space's: a restricted database in an
   * open space passes the space check and would otherwise be editable through its dashboard. 404 when the caller cannot read the
   * database (never says it exists), 403 when they can read but not edit.
   */
  private async assertDatabaseOfView(membership: Membership, databaseId: string, min: 'viewer' | 'editor') {
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, databaseId), eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
      columns: { id: true, spaceId: true },
    });
    if (!database) throw new NotFoundException('View not found');
    const role = await this.access.effectiveForDatabase(membership, database);
    if (!role) throw new NotFoundException('View not found');
    if (ACCESS_RANK[role] < ACCESS_RANK[min]) throw new ForbiddenException('You need edit access to this database.');
    return database;
  }

  /**
   * #306 — update a view addressed WITHOUT its database.
   *
   * The database-scoped PATCH stays the canonical one for a view that has a
   * database; this exists because a space-level dashboard has no `:db` to route
   * through. It deliberately handles only name / config / placement — the
   * database-scoped endpoint owns config VALIDATION against live fields, which
   * is meaningless for a view with no database.
   */
  /**
   * #383 — delete a view addressed WITHOUT its database.
   *
   * There was no way to delete a space-level view at all. The only view-delete
   * route is `DELETE /databases/:db/views/:view`, and `ViewsService.remove()`
   * looks the view up with `eq(views.databaseId, databaseId)` — a space-level
   * view has `databaseId = NULL`, which can never equal any database id, so it
   * 404s from EVERY database including the one it used to live on. #306 made
   * space-root dashboards routine while the ability to remove one did not exist,
   * so creating a dashboard was a one-way door.
   *
   * Deliberately does NOT carry `ViewsService.remove()`'s "a database must keep
   * at least one view" rule. That rule protects a DATABASE from losing its last
   * lens; a space-level view is nobody's last lens, and applying it here would
   * make a space's only dashboard undeletable for a second reason.
   */
  async removeById(membership: Membership, viewId: string) {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), notDeleted(views.deletedAt)),
    });
    if (!view) throw new NotFoundException('View not found');
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }
    /**
     * A database-owned view keeps its existing route, which owns the keep-one
     * rule. Routing it here would quietly bypass that rule — the endpoint has to
     * refuse rather than become a second, laxer way to delete the same thing.
     */
    if (view.databaseId) {
      await this.assertDatabaseOfView(membership, view.databaseId, 'editor');
      throw new UnprocessableEntityException(
        'This view belongs to a database. Delete it through that database, which enforces that a database keeps at least one view.',
      );
    }
    if (!view.spaceId) throw new NotFoundException('View not found');

    // Same door as every other space-view operation.
    await this.assertViewSpaceDoor(membership, view.spaceId);
    await this.access.assertSpace(membership, view.spaceId, 'editor').catch(() => {
      throw new ForbiddenException('You need edit access to this space.');
    });

    // #1178 — after every check, before the write: the agent's own `delete` policy holds a run credential's delete (202). A personal
    // view is private from admins and an approval card is listed to admins: its name stays off it.
    await this.agentDeletes.holdIfAgentPolicy({
      workspaceId: membership.workspaceId,
      kind: 'space_view',
      actorId: membership.userId,
      label: view.ownerUserId ? 'a personal view' : `the view "${view.name}"`,
      params: { view_id: viewId },
    });
    await this.db.update(views).set({ deletedAt: new Date() }).where(eq(views.id, viewId));
    // #1059 — a shared space-level view (dashboard) deleted. A personal one is private from admins too, so it is never logged.
    if (!view.ownerUserId) {
      const space = await this.db.query.spaces.findFirst({ where: eq(spaces.id, view.spaceId), columns: { name: true, personal: true } });
      if (space && !space.personal) {
        await recordStructuralEvent(this.db, { workspaceId: membership.workspaceId, kind: 'view', action: 'deleted', id: view.id, name: view.name, extra: { space_id: view.spaceId, space_name: space.name, view_type: view.type } });
      }
    }
    return { deleted: viewId };
  }

  async updateById(
    membership: Membership,
    viewId: string,
    patch: { name?: string; config?: unknown; folder_id?: string | null },
  ) {
    const view = await this.db.query.views.findFirst({ where: and(eq(views.id, viewId), notDeleted(views.deletedAt)) });
    if (!view) throw new NotFoundException('View not found');
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }

    if (view.databaseId) await this.assertDatabaseOfView(membership, view.databaseId, 'editor');

    // Same door as everything else, resolved from whichever side this view has.
    let spaceId = view.spaceId;
    if (!spaceId && view.databaseId) {
      const database = await this.db.query.databases.findFirst({
        where: and(eq(databases.id, view.databaseId), eq(databases.workspaceId, membership.workspaceId)),
        columns: { spaceId: true },
      });
      if (!database) throw new NotFoundException('View not found');
      spaceId = database.spaceId;
    }
    if (!spaceId) throw new NotFoundException('View not found');
    await this.assertViewSpaceDoor(membership, spaceId);
    await this.access.assertSpace(membership, spaceId, 'editor').catch(() => {
      throw new ForbiddenException('You need edit access to this space.');
    });
    if (patch.folder_id) await this.assertFolderInSpace(spaceId, patch.folder_id);

    // #1083 — the body's `config` is untyped on this route; parse it with the same schema the database-scoped route uses.
    let config: ViewConfig | undefined;
    if (patch.config !== undefined) {
      const parsed = viewConfigSchema.safeParse(patch.config);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      config = parsed.data;
    }

    // #1083 — a database's view is saved by the database-scoped update itself, so it gets the same config validation,
    // server-minted form token (#1041), `share` preservation and public-form relation check (#1071) on either route.
    if (view.databaseId) {
      return this.viewsService.update(view.databaseId, viewId, { name: patch.name, config, folder_id: patch.folder_id }, membership);
    }

    // A space dashboard is neither a published view nor a form, so its `share` and `form` are never taken from the body.
    const stored = view.config as ViewConfig | null;
    if (config) config = { ...config, share: stored?.share, form: stored?.form };

    const [updated] = await this.db
      .update(views)
      .set({
        name: patch.name,
        config: config as never,
        // `undefined` leaves placement alone; explicit null unfiles it. Same
        // distinction the database-scoped endpoint keeps.
        ...(patch.folder_id !== undefined ? { folderId: patch.folder_id } : {}),
      })
      .where(eq(views.id, viewId))
      .returning();
    return updated!;
  }

  /**
   * #306 — move an existing DATABASE-level dashboard into its space.
   *
   * The load-bearing step is the ORDER. Every tile that has not named its own
   * source is implicitly measuring the view's database; clear `database_id`
   * first and that fallback resolves to nothing, so every such tile silently
   * becomes unconfigured. The backfill therefore happens in the SAME
   * transaction, before the column is cleared, and is written from the old
   * owning database.
   *
   * Refused when the dashboard has chart/table WIDGETS. Widgets have no
   * `database_id` — #304 deliberately did not add one rather than ship a field
   * that is accepted and then ignored — so there is nothing to back-fill them
   * with, and moving the container would leave them pointing at a database the
   * view no longer has. Better to refuse and say so than to move a dashboard
   * that comes out half-broken.
   */
  async moveToSpace(membership: Membership, viewId: string) {
    const view = await this.db.query.views.findFirst({ where: and(eq(views.id, viewId), notDeleted(views.deletedAt)) });
    if (!view) throw new NotFoundException('View not found');
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }
    // #945: the database's door first, so a 422 below never confirms a view the caller cannot see.
    if (view.databaseId) await this.assertDatabaseOfView(membership, view.databaseId, 'editor');
    // ticket #1101: the space's door before the 422, for the same reason as the database's door above.
    if (!view.databaseId && view.spaceId) await this.assertViewSpaceDoor(membership, view.spaceId);
    if (!view.databaseId) {
      throw new UnprocessableEntityException('This view already lives in a space.');
    }
    if (view.type !== 'dashboard') {
      throw new UnprocessableEntityException(
        `Only a dashboard can live in a space. A ${view.type} renders rows of a database, so it has to stay on one.`,
      );
    }

    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, view.databaseId), eq(databases.workspaceId, membership.workspaceId)),
      columns: { id: true, spaceId: true, name: true },
    });
    if (!database) throw new NotFoundException('View not found');
    await this.assertViewSpaceDoor(membership, database.spaceId);
    await this.access.assertSpace(membership, database.spaceId, 'editor').catch(() => {
      throw new ForbiddenException('You need edit access to this space.');
    });

    const config = (view.config ?? {}) as {
      dashboard_tiles?: Array<Record<string, unknown>>;
      dashboard_widgets?: Array<Record<string, unknown>>;
    };

    /**
     * #367 — this used to REFUSE any dashboard carrying widgets: a tile with no
     * `database_id` could be backfilled from the database being detached, but a
     * widget had nowhere to put the answer, so moving would have left every chart
     * measuring nothing. Widgets now carry the same field, so the refusal is gone
     * and they are backfilled by the same rule.
     *
     * Only the ones relying on the fallback are filled. Anything that already
     * names a source keeps it — including one deliberately pointing elsewhere.
     */
    const sourceDatabaseId = view.databaseId;
    const backfill = <T extends Record<string, unknown>>(items: T[] | undefined): T[] =>
      (items ?? []).map((item) =>
        item.database_id == null ? { ...item, database_id: sourceDatabaseId } : item,
      );

    const [updated] = await this.db
      .update(views)
      .set({
        config: {
          ...config,
          dashboard_tiles: backfill(config.dashboard_tiles),
          dashboard_widgets: backfill(config.dashboard_widgets),
        } as never,
        spaceId: database.spaceId,
        // Cleared in the SAME statement as the backfill above, so there is no
        // instant at which a tile or widget fallback resolves to nothing.
        databaseId: null,
      })
      .where(eq(views.id, viewId))
      .returning();
    return updated!;
  }
}
