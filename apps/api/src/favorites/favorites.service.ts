import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, favorites, records } from '../db/schema';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

export type FavoriteTarget = 'record' | 'database';

/**
 * Per-user stars (MN-075), access-checked (MN-123).
 *
 * This used to resolve titles by raw id with no workspace filter and no access
 * check, so starring any id and reading the list back returned its title — for
 * scopes the caller would be 404'd from everywhere else. A title leak rather than
 * a data leak, but it bypassed the access model entirely and undercut the
 * deliberate 404-not-403 convention: we hide existence everywhere, then confirm
 * it here.
 */
@Injectable()
export class FavoritesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /** The database behind a favorite, or null when it isn't in this workspace. */
  private async scopeOf(
    workspaceId: string,
    targetType: FavoriteTarget,
    targetId: string,
  ): Promise<{ id: string; spaceId: string } | null> {
    if (targetType === 'database') {
      const db = await this.db.query.databases.findFirst({
        where: and(eq(databases.id, targetId), eq(databases.workspaceId, workspaceId)),
      });
      return db ? { id: db.id, spaceId: db.spaceId } : null;
    }
    const record = await this.db.query.records.findFirst({
      where: and(eq(records.id, targetId), isNull(records.deletedAt)),
    });
    if (!record) return null;
    const db = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, record.databaseId), eq(databases.workspaceId, workspaceId)),
    });
    return db ? { id: db.id, spaceId: db.spaceId } : null;
  }

  /** Can the caller read this target at all? 404 — never confirm it exists. */
  private async assertVisible(membership: Membership, targetType: FavoriteTarget, targetId: string) {
    const scope = await this.scopeOf(membership.workspaceId, targetType, targetId);
    if (!scope) throw new NotFoundException('Not found');
    const effective = await this.access.effectiveForDatabase(membership, scope);
    if (!effective) throw new NotFoundException('Not found');
  }

  async list(membership: Membership) {
    const favs = await this.db.query.favorites.findMany({
      where: and(
        eq(favorites.userId, membership.userId),
        eq(favorites.workspaceId, membership.workspaceId),
      ),
      orderBy: [asc(favorites.createdAt)],
    });
    if (favs.length === 0) return [];

    const recordIds = favs.filter((f) => f.targetType === 'record').map((f) => f.targetId);
    const dbIds = favs.filter((f) => f.targetType === 'database').map((f) => f.targetId);

    // Resolve inside this workspace only — the raw id used to be enough.
    const recs = recordIds.length
      ? await this.db
          .select({
            id: records.id,
            title: records.title,
            databaseId: records.databaseId,
            spaceId: databases.spaceId,
          })
          .from(records)
          .innerJoin(databases, eq(databases.id, records.databaseId))
          .where(
            and(
              inArray(records.id, recordIds),
              isNull(records.deletedAt),
              eq(databases.workspaceId, membership.workspaceId),
            ),
          )
      : [];
    const dbs = dbIds.length
      ? await this.db.query.databases.findMany({
          where: and(inArray(databases.id, dbIds), eq(databases.workspaceId, membership.workspaceId)),
        })
      : [];

    // Admin/member see everything; a guest is filtered to their grants. Memoized
    // per database so a long list doesn't re-resolve the same scope.
    const seen = new Map<string, boolean>();
    const visible = async (scope: { id: string; spaceId: string }) => {
      const cached = seen.get(scope.id);
      if (cached !== undefined) return cached;
      const ok = Boolean(await this.access.effectiveForDatabase(membership, scope));
      seen.set(scope.id, ok);
      return ok;
    };

    const recMap = new Map(recs.map((r) => [r.id, r]));
    const dbMap = new Map(dbs.map((d) => [d.id, d]));
    const out: Array<{
      target_type: FavoriteTarget;
      target_id: string;
      title: string;
      database_id?: string;
      icon?: string | null;
    }> = [];

    for (const f of favs) {
      if (f.targetType === 'record') {
        const r = recMap.get(f.targetId);
        if (!r) continue;
        if (!(await visible({ id: r.databaseId, spaceId: r.spaceId }))) continue;
        out.push({
          target_type: 'record',
          target_id: f.targetId,
          title: r.title || 'Untitled',
          database_id: r.databaseId,
        });
      } else {
        const d = dbMap.get(f.targetId);
        if (!d) continue;
        if (!(await visible({ id: d.id, spaceId: d.spaceId }))) continue;
        out.push({ target_type: 'database', target_id: f.targetId, title: d.name, icon: d.icon });
      }
    }
    return out;
  }

  async add(membership: Membership, targetType: FavoriteTarget, targetId: string) {
    // You may only star what you can already read.
    await this.assertVisible(membership, targetType, targetId);
    await this.db
      .insert(favorites)
      .values({
        userId: membership.userId,
        workspaceId: membership.workspaceId,
        targetType,
        targetId,
      })
      .onConflictDoNothing();
    return { starred: true };
  }

  async remove(membership: Membership, targetType: FavoriteTarget, targetId: string) {
    await this.db.delete(favorites).where(
      and(
        eq(favorites.userId, membership.userId),
        // Workspace-scoped: the same id in another workspace is not yours to touch.
        eq(favorites.workspaceId, membership.workspaceId),
        eq(favorites.targetType, targetType),
        eq(favorites.targetId, targetId),
      ),
    );
    return { starred: false };
  }
}
