import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, favorites, records } from '../db/schema';

export type FavoriteTarget = 'record' | 'database';

/** Per-user stars (MN-075). Titles are resolved so the sidebar can render + link. */
@Injectable()
export class FavoritesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(workspaceId: string, userId: string) {
    const favs = await this.db.query.favorites.findMany({
      where: and(eq(favorites.userId, userId), eq(favorites.workspaceId, workspaceId)),
      orderBy: [asc(favorites.createdAt)],
    });
    const recordIds = favs.filter((f) => f.targetType === 'record').map((f) => f.targetId);
    const dbIds = favs.filter((f) => f.targetType === 'database').map((f) => f.targetId);
    const recs = recordIds.length
      ? await this.db.query.records.findMany({ where: and(inArray(records.id, recordIds), isNull(records.deletedAt)) })
      : [];
    const dbs = dbIds.length ? await this.db.query.databases.findMany({ where: inArray(databases.id, dbIds) }) : [];
    const recMap = new Map(recs.map((r) => [r.id, r]));
    const dbMap = new Map(dbs.map((d) => [d.id, d]));

    const out: Array<{ target_type: FavoriteTarget; target_id: string; title: string; database_id?: string; icon?: string | null }> = [];
    for (const f of favs) {
      if (f.targetType === 'record') {
        const r = recMap.get(f.targetId);
        if (r) out.push({ target_type: 'record', target_id: f.targetId, title: r.title || 'Untitled', database_id: r.databaseId });
      } else {
        const d = dbMap.get(f.targetId);
        if (d) out.push({ target_type: 'database', target_id: f.targetId, title: d.name, icon: d.icon });
      }
    }
    return out;
  }

  async add(workspaceId: string, userId: string, targetType: FavoriteTarget, targetId: string) {
    await this.db
      .insert(favorites)
      .values({ userId, workspaceId, targetType, targetId })
      .onConflictDoNothing();
    return { starred: true };
  }

  async remove(userId: string, targetType: FavoriteTarget, targetId: string) {
    await this.db
      .delete(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.targetType, targetType), eq(favorites.targetId, targetId)));
    return { starred: false };
  }
}
