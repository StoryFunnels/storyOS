import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, records, spaces } from '../db/schema';
import { AuthGuard } from '../auth/auth.guard';
import { AccessService } from '../access/access.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';

/**
 * Global search (MN-048): title trigram over records + name matches on
 * databases/spaces, grant-scoped; plus per-user recents from activity.
 */
@ApiTags('search')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws')
export class SearchController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /** Databases the caller may see, or null for members/admins (= all). */
  private async visibleDatabaseIds(req: WorkspaceRequest): Promise<string[] | null> {
    const visibility = await this.access.guestVisibility(req.membership);
    if (!visibility) return null;
    const rows = await this.db.query.databases.findMany({
      where: and(
        eq(databases.workspaceId, req.membership.workspaceId),
        visibility.spaceIds.size > 0 && visibility.databaseIds.size > 0
          ? or(
              inArray(databases.spaceId, [...visibility.spaceIds]),
              inArray(databases.id, [...visibility.databaseIds]),
            )
          : visibility.spaceIds.size > 0
            ? inArray(databases.spaceId, [...visibility.spaceIds])
            : inArray(databases.id, [...visibility.databaseIds.size ? visibility.databaseIds : new Set([''])]),
      ),
      columns: { id: true },
    });
    return rows.map((r) => r.id);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search records by title + databases/spaces by name (grant-scoped)' })
  async search(@Req() req: WorkspaceRequest, @Query('q') q?: string) {
    const query = (q ?? '').trim();
    if (!query) return { records: [], places: [] };
    const workspaceId = req.membership.workspaceId;
    const visible = await this.visibleDatabaseIds(req);
    if (visible !== null && visible.length === 0) return { records: [], places: [] };

    const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
    const recordRows = await this.db
      .select({
        id: records.id,
        title: records.title,
        database_id: records.databaseId,
        database_name: databases.name,
        database_icon: databases.icon,
        updated_at: records.updatedAt,
      })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(
        and(
          eq(databases.workspaceId, workspaceId),
          isNull(records.deletedAt),
          sql`${records.title} ILIKE ${pattern}`,
          ...(visible !== null ? [inArray(records.databaseId, visible)] : []),
        ),
      )
      .orderBy(
        sql`(${records.title} ILIKE ${query.replace(/[%_]/g, '\\$&') + '%'}) DESC`,
        desc(records.updatedAt),
      )
      .limit(15);

    const databaseRows = await this.db.query.databases.findMany({
      where: and(
        eq(databases.workspaceId, workspaceId),
        sql`${databases.name} ILIKE ${pattern}`,
        ...(visible !== null ? [inArray(databases.id, visible)] : []),
      ),
      columns: { id: true, name: true, icon: true },
      limit: 5,
    });

    let spaceRows: Array<{ id: string; name: string; icon: string | null }> = [];
    if (visible === null) {
      spaceRows = await this.db.query.spaces.findMany({
        where: and(eq(spaces.workspaceId, workspaceId), sql`${spaces.name} ILIKE ${pattern}`),
        columns: { id: true, name: true, icon: true },
        limit: 5,
      });
    }

    return {
      records: recordRows,
      places: [
        ...databaseRows.map((d) => ({ kind: 'database' as const, ...d })),
        ...spaceRows.map((s) => ({ kind: 'space' as const, ...s })),
      ],
    };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Records the caller touched most recently (from activity)' })
  async recent(@Req() req: WorkspaceRequest) {
    const visible = await this.visibleDatabaseIds(req);
    if (visible !== null && visible.length === 0) return { records: [] };

    const rows = await this.db
      .select({
        record_id: activityEvents.recordId,
        last: sql<string>`max(${activityEvents.createdAt})`,
      })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, req.membership.workspaceId),
          eq(activityEvents.actorId, req.user.id),
        ),
      )
      .groupBy(activityEvents.recordId)
      .orderBy(desc(sql`max(${activityEvents.createdAt})`))
      .limit(20);

    const ids = rows.map((r) => r.record_id).filter((v): v is string => Boolean(v));
    if (ids.length === 0) return { records: [] };
    const recent = await this.db
      .select({
        id: records.id,
        title: records.title,
        database_id: records.databaseId,
        database_name: databases.name,
        database_icon: databases.icon,
      })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(
        and(
          inArray(records.id, ids),
          isNull(records.deletedAt),
          ...(visible !== null ? [inArray(records.databaseId, visible)] : []),
        ),
      )
      .limit(10);
    const order = new Map(ids.map((id, i) => [id, i]));
    recent.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    return { records: recent.slice(0, 10) };
  }
}
