import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, spaceFolders, spaces, views } from '../db/schema';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

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
export class SpaceViewsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

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
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, membership.workspaceId)),
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
      where: and(eq(databases.spaceId, spaceId), eq(databases.workspaceId, membership.workspaceId)),
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

    return rows
      .filter((v) => v.databaseId === null || readable.has(v.databaseId))
      .map((v) => ({
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
      }));
  }

  /**
   * #306 — the same door as `listForSpace`, factored out so create/get/move
   * cannot drift from list. Returns the space row once the viewer is cleared.
   */
  private async assertVisibleSpace(membership: Membership, spaceId: string) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, membership.workspaceId)),
      columns: { id: true, personal: true, ownerUserId: true },
    });
    if (!space) throw new NotFoundException('Space not found');
    if (!this.access.canSeePersonal(membership, space)) throw new NotFoundException('Space not found');
    const visible = await this.access.visibleSpaceIds(membership);
    if (visible !== null && !visible.has(spaceId)) throw new NotFoundException('Space not found');
    return space;
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
    const view = await this.db.query.views.findFirst({ where: eq(views.id, viewId) });
    if (!view) throw new NotFoundException('View not found');
    // #291 — another member's personal view is not merely hidden from lists.
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }
    if (view.spaceId) {
      await this.assertVisibleSpace(membership, view.spaceId);
    } else if (view.databaseId) {
      const database = await this.db.query.databases.findFirst({
        where: and(eq(databases.id, view.databaseId), eq(databases.workspaceId, membership.workspaceId)),
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
   * #306 — update a view addressed WITHOUT its database.
   *
   * The database-scoped PATCH stays the canonical one for a view that has a
   * database; this exists because a space-level dashboard has no `:db` to route
   * through. It deliberately handles only name / config / placement — the
   * database-scoped endpoint owns config VALIDATION against live fields, which
   * is meaningless for a view with no database.
   */
  async updateById(
    membership: Membership,
    viewId: string,
    patch: { name?: string; config?: unknown; folder_id?: string | null },
  ) {
    const view = await this.db.query.views.findFirst({ where: eq(views.id, viewId) });
    if (!view) throw new NotFoundException('View not found');
    if (view.ownerUserId && view.ownerUserId !== membership.userId) {
      throw new NotFoundException('View not found');
    }

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
    await this.assertVisibleSpace(membership, spaceId);
    await this.access.assertSpace(membership, spaceId, 'editor').catch(() => {
      throw new ForbiddenException('You need edit access to this space.');
    });
    if (patch.folder_id) await this.assertFolderInSpace(spaceId, patch.folder_id);

    const [updated] = await this.db
      .update(views)
      .set({
        name: patch.name,
        config: patch.config as never,
        // `undefined` leaves placement alone; explicit null unfiles it. Same
        // distinction the database-scoped endpoint keeps.
        ...(patch.folder_id !== undefined ? { folderId: patch.folder_id } : {}),
      })
      .where(eq(views.id, viewId))
      .returning();
    return updated!;
  }
}
