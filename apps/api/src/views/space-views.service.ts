import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, spaces, views } from '../db/schema';
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
}
